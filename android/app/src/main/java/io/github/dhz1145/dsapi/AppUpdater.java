package io.github.dhz1145.dsapi;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.provider.Settings;
import android.util.Log;
import java.io.File;
import java.io.IOException;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import org.json.JSONException;
import org.json.JSONObject;

final class AppUpdater {
    private static final String TAG = "AppUpdater";
    static final int INSTALL_SOURCE_SETTINGS = 6;
    private static final int SYSTEM_INSTALLER = 7;

    private final Activity activity;
    private final PackageInfo installed;
    private final File apk;
    private final Consumer<String> notify;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private volatile String snapshot = "{\"phase\":\"idle\"}";
    private UpdateRelease release;
    private String stagedVersion;
    private boolean busy;
    private boolean resumed;
    private boolean foregroundCheckPending = true;
    private boolean returningFromInstaller;
    private int offer;
    private boolean awaitingPermission;
    private boolean permissionReturned;

    AppUpdater(Activity activity, Consumer<String> notify) {
        this.activity = activity;
        this.notify = notify;
        installed = UpdateRelease.installed(activity);
        apk = UpdateApkProvider.apk(activity);
        if (apk.isFile()) {
            busy = true;
            snapshot = "{\"phase\":\"checking\"}";
            worker.execute(() -> {
                String version = null;
                try {
                    version = UpdateRelease.verifyApk(activity, installed, apk, null);
                } catch (UpdateRelease.InvalidApk | RuntimeException invalid) {
                    apk.delete();
                }
                String restoredVersion = version;
                post(() -> {
                    busy = false;
                    stagedVersion = restoredVersion;
                    publish();
                    checkOnForeground();
                });
            });
        }
    }

    String status() { return snapshot; }

    void check() { check(false); }

    private void checkOnForeground() {
        if (!foregroundCheckPending || busy || !resumed) return;
        foregroundCheckPending = false;
        check(true);
    }

    private void check(boolean automatic) {
        if (busy || !resumed) return;
        busy = true;
        publish("checking", null, null, null);
        worker.execute(() -> {
            try {
                UpdateRelease latest = UpdateRelease.latest(installed.versionName);
                post(() -> {
                    busy = false;
                    release = latest;
                    if (automatic && latest != null) offer++;
                    publish(latest == null ? "current" : null, automatic);
                    checkOnForeground();
                });
            } catch (IOException failure) {
                Log.w(TAG, "Release lookup failed: " + failure.getClass().getSimpleName());
                post(() -> {
                    busy = false;
                    publish("checkFailed", automatic);
                    checkOnForeground();
                });
            }
        });
    }

    void update() {
        if (busy || !resumed || awaitingPermission) return;
        if (stagedVersion != null && (release == null || stagedVersion.equals(release.version()))) {
            install(true);
            return;
        }
        if (release == null) return;
        UpdateRelease target = release;
        busy = true;
        publish("downloading", target.version(), 0, null);
        worker.execute(() -> download(target));
    }

    private void download(UpdateRelease target) {
        File temporary = null;
        try {
            File directory = apk.getParentFile();
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("No update cache");
            temporary = File.createTempFile("download-", ".apk", directory);
            target.download(temporary, progress ->
                post(() -> publish("downloading", target.version(), progress, null)));
            UpdateRelease.verifyApk(activity, installed, temporary, target.version());
            if (Thread.currentThread().isInterrupted() || !temporary.renameTo(apk)) {
                throw new IOException("Could not stage APK");
            }
            post(() -> {
                busy = false;
                stagedVersion = target.version();
                publish();
                if (resumed) install(true);
            });
        } catch (UpdateRelease.InvalidApk invalid) {
            finishDownload("invalidApk", invalid);
        } catch (IOException | RuntimeException failure) {
            finishDownload("downloadFailed", failure);
        } finally {
            if (temporary != null) temporary.delete();
        }
    }

    private void finishDownload(String message, Exception failure) {
        Log.w(TAG, "Update download failed: " + failure.getClass().getSimpleName());
        post(() -> {
            busy = false;
            publish(message);
        });
    }

    void resume() {
        resumed = true;
        if (awaitingPermission || returningFromInstaller) foregroundCheckPending = false;
        returningFromInstaller = false;
        finishPermissionRequest();
        checkOnForeground();
    }

    void pause() { resumed = false; }

    void stop() { foregroundCheckPending = true; }

    void close() { worker.shutdownNow(); }

    void permissionResult() {
        if (!awaitingPermission) return;
        permissionReturned = true;
        finishPermissionRequest();
    }

    private void finishPermissionRequest() {
        if (!resumed || !permissionReturned) return;
        permissionReturned = false;
        awaitingPermission = false;
        install(false);
    }

    @SuppressWarnings("deprecation") // Some OEMs register only ACTION_INSTALL_PACKAGE.
    private void install(boolean promptForPermission) {
        if (!apk.isFile()) {
            stagedVersion = null;
            publish("apkMissing");
            return;
        }
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            if (!promptForPermission) {
                publish("permissionDenied");
            } else if (!openPermissionSettings(true) && !openPermissionSettings(false)) {
                publish("installerUnavailable");
            }
            return;
        }
        if (!launchInstaller(Intent.ACTION_VIEW) && !launchInstaller(Intent.ACTION_INSTALL_PACKAGE)) {
            publish("installerUnavailable");
        }
    }

    private boolean openPermissionSettings(boolean appSpecific) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
        if (appSpecific) intent.setData(Uri.fromParts("package", installed.packageName, null));
        try {
            activity.startActivityForResult(intent, INSTALL_SOURCE_SETTINGS);
            awaitingPermission = true;
            return true;
        } catch (ActivityNotFoundException | SecurityException failure) {
            return false;
        }
    }

    private boolean launchInstaller(String action) {
        Uri uri = UpdateApkProvider.uri(activity);
        Intent intent = new Intent(action)
            .setDataAndType(uri, UpdateApkProvider.MIME_TYPE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.setClipData(ClipData.newRawUri("APK", uri));
        int flags = PackageManager.MATCH_DEFAULT_ONLY | PackageManager.MATCH_SYSTEM_ONLY
            | PackageManager.GET_RESOLVED_FILTER;
        for (ResolveInfo handler : activity.getPackageManager().queryIntentActivities(intent, flags)) {
            if (Intent.ACTION_VIEW.equals(action)) {
                Iterator<String> types = handler.filter == null ? null : handler.filter.typesIterator();
                boolean handlesApks = false;
                while (types != null && types.hasNext()) {
                    if (UpdateApkProvider.MIME_TYPE.equals(types.next())) {
                        handlesApks = true;
                        break;
                    }
                }
                if (!handlesApks) continue;
            }
            Intent explicit = new Intent(intent).setClassName(handler.activityInfo.packageName,
                handler.activityInfo.name);
            try {
                // Preserve the calling package on installers that obtain it from the activity result.
                activity.startActivityForResult(explicit, SYSTEM_INSTALLER);
                returningFromInstaller = true;
                return true;
            } catch (ActivityNotFoundException | SecurityException failure) {
                // Some ROMs expose several installer activities with different access rules.
            }
        }
        return false;
    }

    private void post(Runnable action) {
        activity.runOnUiThread(() -> {
            if (!activity.isDestroyed() && !activity.isFinishing()) action.run();
        });
    }

    private void publish() { publish(null); }

    private void publish(String message) { publish(message, false); }

    private void publish(String message, boolean automatic) {
        if (stagedVersion != null && (release == null || stagedVersion.equals(release.version()))) {
            publish("ready", stagedVersion, null, message, automatic);
        } else if (release != null) {
            publish("available", release.version(), null, message, automatic);
        } else {
            publish("idle", null, null, message, automatic);
        }
    }

    private void publish(String phase, String version, Integer progress, String message) {
        publish(phase, version, progress, message, false);
    }

    private void publish(String phase, String version, Integer progress, String message, boolean automatic) {
        try {
            JSONObject status = new JSONObject().put("phase", phase)
                .put("version", version).put("progress", progress).put("offer", offer).put("automatic", automatic);
            snapshot = status.toString();
            notify.accept(status.put("message", message).toString());
        } catch (JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
