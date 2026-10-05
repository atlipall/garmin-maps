package is.atlipall.garminmap;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import java.io.File;

/**
 * Starting and stopping a trip, from the map's record button (garminmap://trip/start and /stop),
 * the notification's Stop (garminmap://trip/stop) or the log screen (garminmap://trip/resend: the
 * last finished trip again). It's a screen, briefly, because only a screen in front may open the
 * map (Android doesn't let a notification's service do it), and a recorder started from it may use
 * location in the background without "Allow all the time".
 *
 * It answers the map in its address: `#trip-recording=<start>` once the recorder runs,
 * `#trip-failed=location` when precise location is refused, and `#trip=…` with the finished trip.
 */
public class TripActivity extends Activity {
    private static final int ASK = 1;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Uri uri = getIntent().getData();
        String what = uri == null ? "" : uri.getPath();
        App.log(this, "trip: asked " + what);
        if ("/stop".equals(what)) {
            stopService(new Intent(this, TripRecorder.class));
            File done = TripStore.finish(this);
            if (done != null) TripStore.handOver(this, done);
            finish();
        } else if ("/resend".equals(what)) {
            File last = TripStore.last(this);
            if (last != null) TripStore.handOver(this, last);
            finish();
        } else if (precise()) {
            start();
        } else {
            requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, ASK);
        }
    }

    private boolean precise() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (precise()) start();
        else {
            // Refused, or approximate only (no use for a track).
            App.log(this, "trip: precise location refused, not recording");
            TripStore.openMap(this, "trip-failed=location");
            finish();
        }
    }

    private void start() {
        long start = TripStore.begin(this);
        Intent i = new Intent(this, TripRecorder.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
        else startService(i);
        TripStore.openMap(this, "trip-recording=" + start);
        finish();
    }
}
