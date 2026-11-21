package io.github.lijiahua1024.dsreplica;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.DigestOutputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.concurrent.CompletionService;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorCompletionService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.IntConsumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

record UpdateRelease(String version, URL url, URL assetApi, long size, String digest) {
    private static final String REPOSITORY = "dhz1145/deepseek-api";
    private static final String RELEASES_API = "https://api.github.com/repos/" + REPOSITORY + "/releases";
    private static final String LATEST = RELEASES_API + "/latest";
    private static final String DOWNLOAD = "https://github.com/" + REPOSITORY + "/releases/download/";
    private static final String PAGES = "https://dhz1145.github.io/deepseek-api/updates/";
    private static final Pattern VERSION = Pattern.compile("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})");
    private static final long MAX_APK = 256L * 1024 * 1024;

    static UpdateRelease latest(String installedVersion) throws IOException {
        return firstUsable(
            () -> fromGitHub(readJson(LATEST, "application/vnd.github+json", 5000, 6000, 512 * 1024),
                installedVersion),
            () -> fromPages(readJson(PAGES + "latest.json", "application/json", 3500, 4500, 4096),
                installedVersion),
            12_000, 1000);
    }

    @FunctionalInterface
    interface Lookup {
        UpdateRelease run() throws IOException, JSONException;
    }

    private record LookupResult(boolean github, UpdateRelease release, IOException failure) {}

    private static LookupResult lookup(boolean github, Lookup source) {
        try {
            return new LookupResult(github, source.run(), null);
        } catch (IOException | JSONException failure) {
            return new LookupResult(github, null, new IOException(
                (github ? "GitHub" : "Pages") + " lookup failed", failure));
        }
    }

    static UpdateRelease firstUsable(Lookup github, Lookup pages, long timeoutMs, long graceMs)
        throws IOException {
        ExecutorService executor = Executors.newFixedThreadPool(2);
        CompletionService<LookupResult> replies = new ExecutorCompletionService<>(executor);
        Future<LookupResult> githubTask = replies.submit(() -> lookup(true, github));
        Future<LookupResult> pagesTask = replies.submit(() -> lookup(false, pages));
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        LookupResult mirror = null;
        IOException githubFailure = null;
        try {
            for (int remaining = 2; remaining > 0; remaining--) {
                Future<LookupResult> next = replies.poll(Math.max(0, deadline - System.nanoTime()),
                    TimeUnit.NANOSECONDS);
                if (next == null) break;
                LookupResult result = next.get();
                if (result.github()) {
                    if (result.failure() == null) return result.release();
                    githubFailure = result.failure();
                } else {
                    mirror = result;
                    // A cached "current" answer must not mask a newer GitHub Release.
                    // With a usable APK, give GitHub a short chance to supersede a stale mirror.
                    if (mirror.release() != null) {
                        deadline = Math.min(deadline, System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(graceMs));
                    }
                }
            }
            if (mirror != null && mirror.failure() == null) return mirror.release();
            IOException failure = new IOException("No reachable update metadata source");
            if (githubFailure != null) failure.addSuppressed(githubFailure);
            if (mirror != null && mirror.failure() != null) failure.addSuppressed(mirror.failure());
            throw failure;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException("Update check interrupted", interrupted);
        } catch (ExecutionException failed) {
            throw new IOException("Update check failed", failed.getCause());
        } finally {
            githubTask.cancel(true);
            pagesTask.cancel(true);
            executor.shutdownNow();
        }
    }

    private static JSONObject readJson(String url, String accept, int connectMs, int readMs, int maxBytes)
        throws IOException, JSONException {
        HttpsURLConnection connection = connect(new URL(url), connectMs, readMs);
        try {
            connection.setRequestProperty("Accept", accept);
            if (connection.getResponseCode() != 200) throw new IOException("Release lookup failed");
            try (InputStream input = connection.getInputStream()) {
                ByteArrayOutputStream body = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(readMs);
                for (int count; (count = input.read(buffer)) != -1;) {
                    checkDeadline(deadline);
                    if (body.size() + count > maxBytes) throw new IOException("Release response too large");
                    body.write(buffer, 0, count);
                }
                return new JSONObject(new String(body.toByteArray(), StandardCharsets.UTF_8));
            }
        } finally {
            connection.disconnect();
        }
    }

    static UpdateRelease fromGitHub(JSONObject release, String installedVersion) throws IOException, JSONException {
        String tag = release.getString("tag_name");
        if (release.getBoolean("draft") || release.getBoolean("prerelease")) {
            throw new IOException("Unexpected non-stable release");
        }
        String version = versionFromTag(tag);
        if (compareVersions(version, installedVersion) <= 0) return null;
        String name = apkName(tag);
        String expectedUrl = DOWNLOAD + tag + "/" + name;
        JSONArray assets = release.getJSONArray("assets");
        for (int i = 0; i < assets.length(); i++) {
            JSONObject asset = assets.getJSONObject(i);
            if (!name.equals(asset.optString("name"))) continue;
            String digest = asset.optString("digest");
            if ("uploaded".equals(asset.optString("state"))
                && expectedUrl.equals(asset.optString("browser_download_url"))
                && digest.startsWith("sha256:")) {
                return verifiedMetadata(tag, asset.optLong("id"), asset.optLong("size"), digest.substring(7));
            }
        }
        throw new IOException("No verifiable APK for the latest release");
    }

    static UpdateRelease fromPages(JSONObject manifest, String installedVersion) throws IOException, JSONException {
        if (manifest.getInt("schema") != 1) throw new IOException("Unexpected update manifest schema");
        String tag = manifest.getString("tag");
        UpdateRelease release = verifiedMetadata(tag, manifest.getLong("assetId"), manifest.getLong("size"),
            manifest.getString("sha256"));
        return compareVersions(release.version(), installedVersion) > 0 ? release : null;
    }

    private static UpdateRelease verifiedMetadata(String tag, long id, long size, String digest) throws IOException {
        String version = versionFromTag(tag);
        if (id <= 0 || size <= 0 || size > MAX_APK || !digest.matches("[0-9a-f]{64}")) {
            throw new IOException("Invalid update asset metadata");
        }
        return new UpdateRelease(version, new URL(DOWNLOAD + tag + "/" + apkName(tag)),
            new URL(RELEASES_API + "/assets/" + id), size, digest);
    }

    private static String versionFromTag(String tag) throws IOException {
        if (!tag.startsWith("v") || !VERSION.matcher(tag.substring(1)).matches()) {
            throw new IOException("Unexpected release tag");
        }
        return tag.substring(1);
    }

    private static String apkName(String tag) { return "deepseek-api-" + tag + ".apk"; }

    static int compareVersions(String left, String right) throws IOException {
        Matcher a = VERSION.matcher(left == null ? "" : left);
        Matcher b = VERSION.matcher(right == null ? "" : right);
        if (!a.matches() || !b.matches()) throw new IOException("Invalid release version");
        for (int i = 1; i <= 3; i++) {
            int order = Integer.compare(Integer.parseInt(a.group(i)), Integer.parseInt(b.group(i)));
            if (order != 0) return order;
        }
        return 0;
    }

    void download(File file, IntConsumer progress) throws IOException, InvalidApk {
        URL mirror = new URL(PAGES + apkName("v" + version));
        download(file, progress, mirror, assetApi, url);
    }

    void download(File file, IntConsumer progress, URL... sources) throws IOException, InvalidApk {
        IOException unavailable = new IOException("APK download failed on all update sources");
        InvalidApk invalid = null;
        for (int i = 0; i < sources.length; i++) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Update interrupted");
            if (i > 0) progress.accept(0);
            try {
                downloadFrom(sources[i], file, progress);
                return;
            } catch (InvalidApk failure) {
                invalid = failure;
            } catch (IOException failure) {
                unavailable.addSuppressed(failure);
            }
        }
        if (invalid != null) throw invalid;
        throw unavailable;
    }

    private void downloadFrom(URL source, File file, IntConsumer progress) throws IOException, InvalidApk {
        MessageDigest hash;
        try {
            hash = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
        boolean pages = source.toString().startsWith(PAGES);
        URL next = source;
        for (int redirect = 0; redirect < 5; redirect++) {
            HttpsURLConnection connection = connect(next, pages ? 3500 : 8000, pages ? 6000 : 12000);
            try {
                connection.setRequestProperty("Accept", "application/octet-stream");
                int status = connection.getResponseCode();
                if (status == 200) {
                    String contentType = connection.getContentType();
                    if (contentType != null && (contentType.startsWith("application/json")
                        || contentType.startsWith("application/vnd.github+json")
                        || contentType.startsWith("text/"))) {
                        throw new IOException("Expected a binary release asset");
                    }
                    copyApk(connection, file, hash, progress);
                    return;
                }
                String location = connection.getHeaderField("Location");
                if (pages || status < 300 || status >= 400 || location == null) break;
                next = new URL(next, location);
                if (!"release-assets.githubusercontent.com".equalsIgnoreCase(next.getHost())
                    && !"objects.githubusercontent.com".equalsIgnoreCase(next.getHost())) break;
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("APK download failed");
    }

    private void copyApk(HttpsURLConnection connection, File file, MessageDigest hash,
                         IntConsumer progress) throws IOException, InvalidApk {
        try (InputStream input = connection.getInputStream();
             DigestOutputStream output = new DigestOutputStream(new FileOutputStream(file), hash)) {
            byte[] buffer = new byte[32 * 1024];
            long downloaded = 0;
            int lastProgress = 0;
            long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(5);
            for (int count; (count = input.read(buffer)) != -1;) {
                checkDeadline(deadline);
                downloaded += count;
                if (downloaded > size) throw new InvalidApk();
                output.write(buffer, 0, count);
                int percent = (int) (downloaded * 100 / size);
                if (percent >= lastProgress + 5 && percent < 100) {
                    progress.accept(percent);
                    lastProgress = percent;
                }
            }
            byte[] actual = hash.digest();
            if (downloaded != size || !MessageDigest.isEqual(parseDigest(digest), actual)) {
                throw new InvalidApk();
            }
        }
    }

    private static byte[] parseDigest(String digest) {
        byte[] bytes = new byte[32];
        for (int i = 0; i < bytes.length; i++) {
            bytes[i] = (byte) Integer.parseInt(digest.substring(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    }

    private static HttpsURLConnection connect(URL url, int connectMs, int readMs) throws IOException {
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null
            || (url.getPort() != -1 && url.getPort() != 443)) {
            throw new IOException("Invalid update URL");
        }
        HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setConnectTimeout(connectMs);
        connection.setReadTimeout(readMs);
        connection.setRequestProperty("User-Agent", "DeepSeek-API-Android");
        return connection;
    }

    private static void checkDeadline(long deadline) throws IOException {
        if (Thread.currentThread().isInterrupted() || deadline - System.nanoTime() <= 0) {
            throw new IOException("Update request interrupted");
        }
    }

    static PackageInfo installed(Context context) {
        try {
            return context.getPackageManager().getPackageInfo(context.getPackageName(),
                PackageManager.GET_SIGNING_CERTIFICATES);
        } catch (PackageManager.NameNotFoundException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static String verifyApk(Context context, PackageInfo installed, File file, String version)
        throws InvalidApk {
        PackageInfo apk = context.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(),
            PackageManager.GET_SIGNING_CERTIFICATES);
        if (apk == null || !installed.packageName.equals(apk.packageName) || apk.versionName == null
            || (version != null && !version.equals(apk.versionName))
            || apk.getLongVersionCode() <= installed.getLongVersionCode()
            || apk.applicationInfo == null || apk.applicationInfo.minSdkVersion > Build.VERSION.SDK_INT
            || apk.signingInfo == null || installed.signingInfo == null) {
            throw new InvalidApk();
        }
        Signature[] existing = installed.signingInfo.getApkContentsSigners();
        Signature[] incoming = apk.signingInfo.getApkContentsSigners();
        if (existing == null || existing.length == 0 || incoming == null || incoming.length == 0) {
            throw new InvalidApk();
        }
        boolean sameSigners = new HashSet<>(Arrays.asList(existing))
            .equals(new HashSet<>(Arrays.asList(incoming)));
        Signature[] history = apk.signingInfo.getSigningCertificateHistory();
        boolean rotated = existing.length == 1 && incoming.length == 1 && history != null
            && Arrays.asList(history).contains(existing[0]);
        if (!sameSigners && !rotated) throw new InvalidApk();
        return apk.versionName;
    }

    static final class InvalidApk extends Exception {}
}
