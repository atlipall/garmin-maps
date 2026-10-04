package is.atlipall.garminmap;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * The app's entry point: starts the app in Chrome (ChromeLauncher), or, when the last start
 * crashed, shows what went wrong (App records it) with a way to try again or to use the built-in
 * browser instead (MainActivity).
 */
public class StartActivity extends Activity {
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        File report = new File(getFilesDir(), App.REPORT);
        if (!report.exists()) {
            startActivity(new Intent(this, ChromeLauncher.class));
            finish();
            return;
        }
        String text;
        try {
            text = new String(Files.readAllBytes(report.toPath()), StandardCharsets.UTF_8);
        } catch (Exception e) {
            text = "The report could not be read: " + e;
        }
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(48, 32, 48, 32);
        page.setBackgroundColor(Color.WHITE);
        TextView title = new TextView(this);
        title.setText("Garmin Map stopped the last time it started. Take a photo of this screen and send it on.");
        title.setTextSize(20);
        title.setTextColor(Color.BLACK);
        page.addView(title);
        LinearLayout buttons = new LinearLayout(this);
        Button again = new Button(this);
        again.setText("Try again");
        again.setOnClickListener(v -> {
            report.delete();
            startActivity(new Intent(this, ChromeLauncher.class));
            finish();
        });
        Button builtIn = new Button(this);
        builtIn.setText("Use the built-in browser");
        builtIn.setOnClickListener(v -> {
            report.delete();
            startActivity(new Intent(this, MainActivity.class));
            finish();
        });
        buttons.addView(again);
        buttons.addView(builtIn);
        page.addView(buttons);
        TextView details = new TextView(this);
        details.setText(text);
        details.setTextSize(13);
        details.setTextColor(Color.DKGRAY);
        details.setTextIsSelectable(true);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(details);
        page.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(page);
    }
}
