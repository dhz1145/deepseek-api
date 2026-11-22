package io.github.dhz1145.dsapi;

import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ForkJoinPool;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/** Moves API traffic out of the WebView while streaming the response back through a local URL. */
final class NativeApiTransport {
    static final String PATH = "/_native_api/";
    private static final Set<String> HEADERS = Set.of("authorization", "x-api-key",
        "anthropic-version", "anthropic-beta", "accept", "content-type");
    private final File cache;
    private final Map<String, Call> calls = new ConcurrentHashMap<>();
    private boolean closed;

    NativeApiTransport(File cache) { this.cache = cache; }

    @JavascriptInterface
    public synchronized String prepare(String address, String method, String headers) {
        if (closed || !("GET".equals(method) || "POST".equals(method) || "DELETE".equals(method))) {
            return null;
        }
        try {
            URI uri = new URI(address);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null
                    || uri.getRawUserInfo() != null || uri.getRawFragment() != null) return null;
            JSONObject fields = new JSONObject(headers);
            Map<String, String> forwarded = new HashMap<>();
            for (Iterator<String> names = fields.keys(); names.hasNext();) {
                String name = names.next();
                if (!HEADERS.contains(name)) continue;
                String value = fields.getString(name);
                if (value.contains("\r") || value.contains("\n")) return null;
                forwarded.put(name, value);
            }
            String id = UUID.randomUUID().toString();
            calls.put(id, new Call(uri.toURL(), method, forwarded));
            return id;
        } catch (Exception ignored) {
            return null;
        }
    }

    @JavascriptInterface
    public boolean append(String id, String chunk) {
        Call call = calls.get(id);
        if (call == null || chunk == null || chunk.length() > 45000) return false;
        try {
            return call.append(cache, Base64.decode(chunk, Base64.NO_WRAP));
        } catch (IOException | IllegalArgumentException ignored) {
            return false;
        }
    }

    @JavascriptInterface
    public void cancel(String id) {
        finish(id, true);
    }

    private void finish(String id, boolean async) {
        Call call = calls.remove(id);
        if (call != null) call.close(async);
    }

    void cancelAll() {
        for (String id : calls.keySet()) cancel(id);
    }

    void shutdown() {
        synchronized (this) { closed = true; }
        cancelAll();
    }

    WebResourceResponse open(String id) {
        Call call = calls.get(id);
        if (call == null || !call.claim()) return failure("No active API request");
        boolean streaming = false;
        try {
            HttpsURLConnection connection = (HttpsURLConnection) call.url.openConnection();
            if (!call.attach(connection)) return failure("API request cancelled");
            // Never forward the API key to a redirect destination.
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(20_000);
            connection.setReadTimeout(120_000);
            connection.setUseCaches(false);
            connection.setRequestMethod(call.method);
            for (Map.Entry<String, String> header : call.headers.entrySet()) {
                connection.setRequestProperty(header.getKey(), header.getValue());
            }
            RandomAccessFile source = call.body();
            if (source != null) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(source.length());
                source.seek(0);
                try (OutputStream sink = connection.getOutputStream()) {
                    byte[] buffer = new byte[32768];
                    for (int size; (size = source.read(buffer)) != -1;) sink.write(buffer, 0, size);
                } finally {
                    call.clearBody();
                }
            }
            int status = connection.getResponseCode();
            if (status >= 300 && status < 400) return failure("API returned a redirect (HTTP " + status + ")");
            if (status < 200 || status > 599) return failure("Invalid HTTPS response");
            String contentType = connection.getContentType();
            Map<String, String> responseHeaders = new HashMap<>();
            responseHeaders.put("Cache-Control", "no-store");
            responseHeaders.put("X-Content-Type-Options", "nosniff");
            responseHeaders.put("Content-Security-Policy", "default-src 'none'; sandbox");
            if (contentType != null) responseHeaders.put("Content-Type", contentType);
            InputStream body = status == 204 || status == 205 ? null
                : status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String mime = contentType == null ? "application/octet-stream" : contentType.split(";", 2)[0].trim();
            if (body == null) {
                return new WebResourceResponse(mime, null, status, "API Response", responseHeaders,
                    new ByteArrayInputStream(new byte[0]));
            }
            InputStream stream = new FilterInputStream(body) {
                @Override
                public void close() throws IOException {
                    try { super.close(); } finally { finish(id, false); }
                }
            };
            WebResourceResponse response = new WebResourceResponse(mime, null, status,
                "API Response", responseHeaders, stream);
            streaming = true;
            return response;
        } catch (SocketTimeoutException ignored) {
            return failure("HTTPS API request timed out");
        } catch (IOException | RuntimeException ignored) {
            return failure("Could not connect to the HTTPS API");
        } finally {
            if (!streaming) finish(id, false);
        }
    }

    private static WebResourceResponse failure(String message) {
        return new WebResourceResponse("text/plain", "UTF-8", 502, "Native API Error",
            Map.of("Cache-Control", "no-store", "X-Native-Api-Error", "1"),
            new ByteArrayInputStream(message.getBytes(StandardCharsets.UTF_8)));
    }

    private static final class Call {
        final URL url;
        final String method;
        final Map<String, String> headers;
        private File uploadPath;
        private RandomAccessFile upload;
        private HttpsURLConnection connection;
        private boolean claimed;
        private boolean cancelled;

        Call(URL url, String method, Map<String, String> headers) {
            this.url = url;
            this.method = method;
            this.headers = headers;
        }

        synchronized boolean append(File cache, byte[] bytes) throws IOException {
            if (claimed || cancelled || !"POST".equals(method)) return false;
            if (upload == null) {
                uploadPath = File.createTempFile("api-upload-", ".tmp", cache);
                upload = new RandomAccessFile(uploadPath, "rw");
                // Android can unlink the staged payload while the descriptor is still open.
                if (uploadPath.delete()) uploadPath = null;
            }
            upload.write(bytes);
            return true;
        }

        synchronized boolean claim() {
            if (claimed || cancelled) return false;
            claimed = true;
            return true;
        }

        synchronized boolean attach(HttpsURLConnection value) {
            if (cancelled) return false;
            connection = value;
            return true;
        }

        synchronized RandomAccessFile body() { return upload; }

        synchronized void clearBody() {
            if (upload != null) {
                try { upload.close(); } catch (IOException ignored) {}
                upload = null;
            }
            if (uploadPath != null && uploadPath.delete()) uploadPath = null;
        }

        void close(boolean async) {
            HttpsURLConnection active;
            synchronized (this) {
                cancelled = true;
                clearBody();
                active = connection;
            }
            if (active == null) return;
            if (async) {
                // Cancellation may interrupt a blocking HTTP read; do not disconnect on the UI/bridge thread.
                ForkJoinPool.commonPool().execute(active::disconnect);
            } else {
                active.disconnect();
            }
        }
    }
}
