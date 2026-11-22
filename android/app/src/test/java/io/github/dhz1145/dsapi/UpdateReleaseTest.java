package io.github.dhz1145.dsapi;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class UpdateReleaseTest {
    private static final String DIGEST = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    private static JSONObject manifest(String tag) throws Exception {
        return new JSONObject().put("schema", 1).put("tag", tag).put("size", 5)
            .put("assetId", 123).put("sha256", DIGEST);
    }

    private static UpdateRelease candidate(String tag) throws Exception {
        return UpdateRelease.fromMirrorManifest(manifest(tag), "0.7.2");
    }

    private static UpdateRelease unavailable() throws IOException { throw new IOException("offline"); }

    @Test public void mirrorContainsOnlyValidatedMetadata() throws Exception {
        UpdateRelease release = UpdateRelease.fromMirrorManifest(manifest("v0.7.3").put("url", "https://other.invalid"), "0.7.2");
        assertEquals("0.7.3", release.version());
        assertEquals("https://github.com/dhz1145/deepseek-api/releases/download/v0.7.3/deepseek-api-v0.7.3.apk",
            release.url().toString());
        assertEquals("https://api.github.com/repos/dhz1145/deepseek-api/releases/assets/123", release.assetApi().toString());
        assertNull(UpdateRelease.fromMirrorManifest(manifest("v0.7.2"), "0.7.2"));
        assertNull(UpdateRelease.fromMirrorManifest(manifest("v0.7.1"), "0.7.2"));
        assertThrows(IOException.class, () -> UpdateRelease.fromMirrorManifest(manifest("v0.7.3-rc1"), "0.7.2"));
        assertThrows(IOException.class, () -> UpdateRelease.fromMirrorManifest(manifest("v0.7.3").put("sha256", "bad"), "0.7.2"));
        assertThrows(IOException.class, () -> UpdateRelease.fromMirrorManifest(manifest("v0.7.3").put("size", 0), "0.7.2"));
        assertThrows(IOException.class, () -> UpdateRelease.fromMirrorManifest(manifest("v0.7.3").put("schema", 2), "0.7.2"));
    }

    @Test public void onlyStableOwnGitHubAssetIsAccepted() throws Exception {
        UpdateRelease expected = candidate("v0.7.3");
        JSONObject asset = new JSONObject().put("name", "deepseek-api-v0.7.3.apk").put("id", 123)
            .put("state", "uploaded").put("size", 5).put("digest", "sha256:" + DIGEST)
            .put("browser_download_url", expected.url().toString());
        JSONObject release = new JSONObject().put("tag_name", "v0.7.3").put("draft", false)
            .put("prerelease", false).put("assets", new JSONArray().put(asset));
        assertEquals(expected.toString(), UpdateRelease.fromGitHub(release, "0.7.2").toString());
        assertThrows(IOException.class, () -> UpdateRelease.fromGitHub(release.put("draft", true), "0.7.2"));
        release.put("draft", false);
        assertThrows(IOException.class, () -> UpdateRelease.fromGitHub(release.put("prerelease", true), "0.7.2"));
        release.put("prerelease", false);
        asset.put("browser_download_url", "https://github.com/somewhere/else/releases/download/v0.7.3/deepseek-api-v0.7.3.apk");
        assertThrows(IOException.class, () -> UpdateRelease.fromGitHub(release, "0.7.2"));
    }

    @Test public void oldMirrorDoesNotHideNewerGitHubRelease() throws Exception {
        UpdateRelease latest = candidate("v0.7.4");
        UpdateRelease mirrored = candidate("v0.7.3");
        for (UpdateRelease stale : new UpdateRelease[] {null, mirrored}) {
            CountDownLatch mirrorStarted = new CountDownLatch(1);
            assertSame(latest, UpdateRelease.firstUsable(() -> {
                await(mirrorStarted);
                return latest;
            }, () -> {
                mirrorStarted.countDown();
                return stale;
            }, 2500, 1000));
        }
    }

    @Test public void reachableSourceSurvivesFailureOfOtherSource() throws Exception {
        UpdateRelease stable = candidate("v0.7.3");
        assertSame(stable, UpdateRelease.firstUsable(UpdateReleaseTest::unavailable, () -> stable, 2500, 1000));
        assertSame(stable, UpdateRelease.firstUsable(() -> stable, UpdateReleaseTest::unavailable, 2500, 1000));
        assertNull(UpdateRelease.firstUsable(() -> null, UpdateReleaseTest::unavailable, 2500, 1000));
        assertNull(UpdateRelease.firstUsable(UpdateReleaseTest::unavailable, () -> null, 2500, 1000));
        assertThrows(IOException.class, () -> UpdateRelease.firstUsable(UpdateReleaseTest::unavailable,
            UpdateReleaseTest::unavailable, 2500, 1000));
    }

    @Test public void healthyMirrorDoesNotWaitForUnresponsiveApi() throws Exception {
        UpdateRelease stable = candidate("v0.7.3");
        assertSame(stable, UpdateRelease.firstUsable(() -> {
            await(new CountDownLatch(1));
            return null;
        }, () -> stable, 2500, 40));
    }

    @Test public void r2MetadataHasPriorityAndPagesRecoversFromAnUnavailableOrStaleR2() throws Exception {
        UpdateRelease r2 = candidate("v0.7.4");
        UpdateRelease pages = candidate("v0.7.3");
        assertSame(r2, UpdateRelease.preferredMirror(() -> r2, () -> {
            throw new AssertionError("Healthy R2 should not require a Pages lookup");
        }));
        assertSame(pages, UpdateRelease.preferredMirror(UpdateReleaseTest::unavailable, () -> pages));
        assertSame(pages, UpdateRelease.preferredMirror(() -> null, () -> pages));
        assertNull(UpdateRelease.preferredMirror(() -> null, UpdateReleaseTest::unavailable));
        assertThrows(IOException.class, () -> UpdateRelease.preferredMirror(UpdateReleaseTest::unavailable,
            UpdateReleaseTest::unavailable));
    }

    @Test public void mirrorFailureOrWrongBytesFallBackToVerifiedRelease() throws Exception {
        UpdateRelease stable = candidate("v0.7.3");
        List<String> requests = new ArrayList<>();
        URL limited = fake("https://updates.example.com/updates/deepseek-api-v0.7.3.apk", 429, "", requests);
        URL missing = fake("https://dhz1145.github.io/deepseek-api/updates/missing.apk", 404, "", requests);
        URL invalid = fake("https://dhz1145.github.io/deepseek-api/updates/invalid.apk", 200, "wrong", requests);
        URL clean = fake("https://api.github.com/releases/assets/123", 200, "hello", requests);
        File apk = File.createTempFile("update-test-", ".apk");
        try {
            stable.download(apk, value -> {}, limited, missing, invalid, clean);
            assertEquals(List.of(limited.toString(), missing.toString(), invalid.toString(), clean.toString()), requests);
            assertEquals("hello", Files.readString(apk.toPath()));
            assertThrows(UpdateRelease.InvalidApk.class, () -> stable.download(apk, value -> {}, invalid));
            assertThrows(IOException.class, () -> stable.download(apk, value -> {}, missing));
        } finally {
            Files.deleteIfExists(apk.toPath());
        }
    }

    private static void await(CountDownLatch latch) throws IOException {
        try {
            if (!latch.await(3, TimeUnit.SECONDS)) throw new IOException("wait expired");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IOException(interrupted);
        }
    }

    private static URL fake(String url, int status, String body, List<String> requests) throws Exception {
        return new URL(null, url, new URLStreamHandler() {
            @Override protected URLConnection openConnection(URL target) {
                requests.add(target.toString());
                return new HttpsURLConnection(target) {
                    @Override public int getResponseCode() { return status; }
                    @Override public String getContentType() { return "application/octet-stream"; }
                    @Override public InputStream getInputStream() {
                        return new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8));
                    }
                    @Override public void connect() {}
                    @Override public void disconnect() {}
                    @Override public boolean usingProxy() { return false; }
                    @Override public String getCipherSuite() { return "test"; }
                    @Override public Certificate[] getLocalCertificates() { return null; }
                    @Override public Certificate[] getServerCertificates() { return null; }
                };
            }
        });
    }
}
