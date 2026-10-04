package is.atlipall.garminmap;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Looper;
import android.os.RemoteException;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.browser.trusted.TrustedWebActivityCallbackRemote;
import com.google.androidbrowserhelper.locationdelegation.PermissionRequestActivity;
import com.google.androidbrowserhelper.trusted.DelegationService;
import com.google.androidbrowserhelper.trusted.ExtraCommandHandler;

/**
 * Location for the app in Chrome. In a Trusted Web Activity Chrome doesn't ask for location itself:
 * it asks the app, through this service, with the commands of androidbrowserhelper's location
 * delegation. The positions come straight from the unit's GPS (Android's LocationManager), as on
 * a car's head unit, where Google Play services' fused location may give none; the permission is
 * asked with the library's PermissionRequestActivity. Every step is logged (App).
 */
public class LocationService extends DelegationService {
    public LocationService() {
        registerExtraCommandHandler(new GpsHandler());
    }

    /** The commands and callbacks of androidbrowserhelper's LocationDelegationExtraCommandHandler. */
    static class GpsHandler implements ExtraCommandHandler, LocationListener {
        private LocationManager manager;
        private TrustedWebActivityCallbackRemote callback;
        private Context context;
        private boolean firstFix;

        @NonNull
        @Override
        public Bundle handleExtraCommand(Context c, String command, Bundle args, @Nullable TrustedWebActivityCallbackRemote cb) {
            context = c.getApplicationContext();
            Bundle result = new Bundle();
            result.putBoolean(EXTRA_COMMAND_SUCCESS, false);
            App.log(context, "location: Chrome asks " + command);
            switch (command) {
                case "checkAndroidLocationPermission":
                    if (cb == null) break;
                    if (granted()) {
                        Bundle ok = new Bundle();
                        ok.putBoolean("locationPermissionResult", true);
                        run(cb, "checkAndroidLocationPermission", ok);
                    } else {
                        App.log(context, "location: asking for permission");
                        PermissionRequestActivity.requestLocationPermission(context, cb);
                    }
                    result.putBoolean(EXTRA_COMMAND_SUCCESS, true);
                    break;
                case "startLocation":
                    if (cb == null) break;
                    start(cb);
                    result.putBoolean(EXTRA_COMMAND_SUCCESS, true);
                    break;
                case "stopLocation":
                    stop();
                    result.putBoolean(EXTRA_COMMAND_SUCCESS, true);
                    break;
                default:
                    break;
            }
            return result;
        }

        private boolean granted() {
            return context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
        }

        @SuppressWarnings("MissingPermission")
        private void start(TrustedWebActivityCallbackRemote cb) {
            stop();
            callback = cb;
            firstFix = true;
            if (!granted()) {
                error("Location permission not granted");
                return;
            }
            manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
            int providers = 0;
            for (String p : new String[] {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                try {
                    if (!manager.isProviderEnabled(p)) {
                        App.log(context, "location: " + p + " is off");
                        continue;
                    }
                    manager.requestLocationUpdates(p, 1000, 0, this, Looper.getMainLooper());
                    providers++;
                    Location last = manager.getLastKnownLocation(p);
                    if (last != null && System.currentTimeMillis() - last.getTime() < 120_000) onLocationChanged(last);
                } catch (Throwable e) {
                    App.log(context, "location: " + p + " failed: " + e);
                }
            }
            App.log(context, "location: listening to " + providers + " source(s)");
            if (providers == 0) error("Location is turned off on this device");
        }

        private void stop() {
            if (manager != null) manager.removeUpdates(this);
            manager = null;
        }

        @Override
        public void onLocationChanged(Location l) {
            if (callback == null) return;
            if (firstFix) {
                App.log(context, "location: first fix from " + l.getProvider() + " (±" + Math.round(l.getAccuracy()) + " m)");
                firstFix = false;
            }
            Bundle b = new Bundle();
            b.putDouble("latitude", l.getLatitude());
            b.putDouble("longitude", l.getLongitude());
            b.putLong("timeStamp", l.getTime());
            if (l.hasAltitude()) b.putDouble("altitude", l.getAltitude());
            if (l.hasAccuracy()) b.putDouble("accuracy", l.getAccuracy());
            if (l.hasBearing()) b.putDouble("bearing", l.getBearing());
            if (l.hasSpeed()) b.putDouble("speed", l.getSpeed());
            run(callback, "onNewLocationAvailable", b);
        }

        private void error(String message) {
            App.log(context, "location: " + message);
            Bundle b = new Bundle();
            b.putString("message", message);
            if (callback != null) run(callback, "onNewErrorAvailable", b);
        }

        private void run(TrustedWebActivityCallbackRemote cb, String name, Bundle args) {
            try {
                cb.runExtraCallback(name, args);
            } catch (RemoteException e) {
                // Chrome went away: stop listening.
                stop();
            }
        }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {}

        @Override
        public void onProviderEnabled(String provider) {}

        @Override
        public void onProviderDisabled(String provider) {}
    }
}
