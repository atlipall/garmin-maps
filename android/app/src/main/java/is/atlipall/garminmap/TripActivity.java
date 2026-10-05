package is.atlipall.garminmap;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;

/**
 * The map's record button lands here (garminmap://trip/start, garminmap://trip/stop): starts or
 * stops the TripRecorder, asking for location first if the app doesn't have it, then gets out of
 * the way (back to the map). Started from the map's tap, the recorder is allowed to use location
 * while in the background without "Allow all the time".
 */
public class TripActivity extends Activity {
    private static final int ASK = 1;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Uri uri = getIntent().getData();
        String what = uri == null ? "" : uri.getPath();
        App.log(this, "trip: the map asks " + what);
        if ("/stop".equals(what)) {
            startService(new Intent(this, TripRecorder.class).setAction(TripRecorder.STOP));
            finish();
        } else if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            start();
        } else {
            requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, ASK);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) start();
        else {
            App.log(this, "trip: location refused, not recording");
            finish();
        }
    }

    private void start() {
        Intent i = new Intent(this, TripRecorder.class).setAction(TripRecorder.START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(i);
        else startService(i);
        finish();
    }
}
