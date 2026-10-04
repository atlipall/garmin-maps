package is.atlipall.garminmap;

import android.app.Application;
import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.webkit.WebView;
import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.Date;

/**
 * Records a crash for the next start to show (StartActivity): a head unit has no other way to get
 * at Android's crash log. The report says what failed and on what (Android, Chrome and WebView
 * versions), so a photo of it is enough to fix it.
 */
public class App extends Application {
    static final String REPORT = "crash.txt";
    /** What happened at the last starts (a few dozen lines), shown on the diagnostics screen. */
    static final String LOG = "log.txt";
    private static final int LOG_KEEP = 60;

    /** Adds a line to the log (dropping the oldest past LOG_KEEP). */
    static synchronized void log(Context c, String line) {
        try {
            File f = new File(c.getFilesDir(), LOG);
            java.util.List<String> lines = f.exists() ? new java.util.ArrayList<>(java.nio.file.Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) : new java.util.ArrayList<>();
            lines.add(new java.text.SimpleDateFormat("HH:mm:ss.SSS", java.util.Locale.ROOT).format(new Date()) + " " + line);
            while (lines.size() > LOG_KEEP) lines.remove(0);
            java.nio.file.Files.write(f.toPath(), lines, StandardCharsets.UTF_8);
        } catch (Throwable ignored) {
            // the log is a help, never a reason to fail
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Thread.UncaughtExceptionHandler system = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            try (FileOutputStream out = new FileOutputStream(new File(getFilesDir(), REPORT))) {
                StringWriter trace = new StringWriter();
                error.printStackTrace(new PrintWriter(trace));
                out.write((new Date() + "\n" + deviceInfo(this) + "\n" + trace).getBytes(StandardCharsets.UTF_8));
            } catch (Throwable ignored) {
                // nothing more to be done
            }
            log(this, "crash: " + error);
            if (system != null) system.uncaughtException(thread, error);
        });
    }

    /** The app, Android, the device, Chrome and the WebView, one per line. */
    static String deviceInfo(Context c) {
        StringBuilder s = new StringBuilder();
        s.append("App ").append(BuildConfig.VERSION_NAME).append(" (").append(BuildConfig.APPLICATION_ID).append(")\n");
        s.append("Android ").append(Build.VERSION.RELEASE).append(" (API ").append(Build.VERSION.SDK_INT).append("), ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL).append('\n');
        s.append("Chrome ").append(version(c, "com.android.chrome")).append('\n');
        String webView = "?";
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                PackageInfo p = WebView.getCurrentWebViewPackage();
                webView = p == null ? "none" : p.packageName + " " + p.versionName;
            }
        } catch (Throwable e) {
            webView = "failed: " + e;
        }
        s.append("WebView ").append(webView).append('\n');
        return s.toString();
    }

    private static String version(Context c, String pkg) {
        try {
            return c.getPackageManager().getPackageInfo(pkg, 0).versionName;
        } catch (Throwable e) {
            return "not installed";
        }
    }
}
