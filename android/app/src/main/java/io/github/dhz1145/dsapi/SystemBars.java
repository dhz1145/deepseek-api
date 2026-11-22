package io.github.dhz1145.dsapi;

import android.graphics.Color;
import android.graphics.Insets;
import android.os.Build;
import android.view.DisplayCutout;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;

final class SystemBars {
    interface InsetsListener {
        void update(Insets safe, boolean keyboardVisible, int buttonNavigationBottom);
    }

    @SuppressWarnings("deprecation") // Android 10 reports the keyboard in the system window insets.
    static void applyInsets(Window window, View content, InsetsListener listener) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            content.setOnApplyWindowInsetsListener((view, insets) -> {
                Insets safe = insets.getInsets(WindowInsets.Type.systemBars()
                    | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                int buttonNavigationBottom = insets.getInsets(WindowInsets.Type.tappableElement()).bottom > 0
                    ? insets.getInsets(WindowInsets.Type.navigationBars()).bottom : 0;
                listener.update(safe, insets.isVisible(WindowInsets.Type.ime()), buttonNavigationBottom);
                return WindowInsets.CONSUMED;
            });
            return;
        }

        View decor = window.getDecorView();
        decor.setSystemUiVisibility(decor.getSystemUiVisibility() | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        content.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets safe = insets.getSystemWindowInsets();
            WindowInsets rootInsets = view.getRootWindowInsets();
            int navigation = rootInsets == null ? insets.getStableInsetBottom()
                : rootInsets.getStableInsetBottom();
            boolean keyboardVisible = safe.bottom > navigation;
            DisplayCutout cutout = insets.getDisplayCutout();
            if (cutout != null) {
                safe = Insets.of(Math.max(safe.left, cutout.getSafeInsetLeft()),
                    Math.max(safe.top, cutout.getSafeInsetTop()),
                    Math.max(safe.right, cutout.getSafeInsetRight()),
                    Math.max(safe.bottom, cutout.getSafeInsetBottom()));
            }
            int buttonNavigationBottom = insets.getTappableElementInsets().bottom > 0
                ? Math.min(safe.bottom, navigation) : 0;
            listener.update(safe, keyboardVisible, buttonNavigationBottom);
            return insets.consumeSystemWindowInsets().consumeStableInsets().consumeDisplayCutout();
        });
    }

    @SuppressWarnings("deprecation") // Android 10 controls icon colors through system UI flags.
    static void setAppearance(Window window, boolean dark) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            int flags = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            window.getInsetsController().setSystemBarsAppearance(dark ? 0 : flags, flags);
        } else {
            View decor = window.getDecorView();
            int flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            int visibility = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(dark ? visibility & ~flags : visibility | flags);
        }
        window.setNavigationBarContrastEnforced(false);
    }

    @SuppressWarnings("deprecation") // Android 10 uses immersive system UI flags.
    static void setFullscreen(Window window, boolean fullscreen) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (fullscreen) {
                controller.setSystemBarsBehavior(
                    WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            } else {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_DEFAULT);
                controller.show(WindowInsets.Type.systemBars());
            }
        } else {
            View decor = window.getDecorView();
            int flags = View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            int visibility = decor.getSystemUiVisibility();
            decor.setSystemUiVisibility(fullscreen ? visibility | flags : visibility & ~flags);
        }
    }

    private SystemBars() {}
}
