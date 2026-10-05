package is.atlipall.garminmap;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.os.Looper;
import java.io.FileWriter;
import java.io.IOException;
import java.util.Locale;

/**
 * Records the trip TripActivity began (TripStore): the unit's GPS, straight from Android, while the
 * map is closed, another app is in front or the screen is off, behind a notification with Stop and
 * Open map. Points are thinned to about one every 10 m (sooner on bends) and appended to a file as
 * they come. If Android kills the service it starts it again and it carries on; where Android won't
 * let it back into the foreground from there (Android 14 and later, without background location),
 * the trip so far is kept as a finished trip instead (the log screen can send it to the map).
 * Stopping is TripActivity's (it ends the trip and hands it to the map).
 */
public class TripRecorder extends Service implements LocationListener {
    private static final int NOTIFICATION = 2;
    private static final String CHANNEL = "trip";
    /** Fixes rougher than this (m) are skipped. */
    private static final float MAX_ACCURACY_M = 50;
    /** The notification's figures are brought up to date this often (ms). */
    private static final long NOTIFY_MS = 15_000;

    private LocationManager manager;
    private final Trip.Thinner thinner = new Trip.Thinner();
    private long started;
    private long lastNotified;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (manager != null) return START_STICKY; // already recording
        started = TripStore.started(this);
        if (started == 0) {
            // Nothing to record (a restart after the trip was stopped).
            stopSelf();
            return START_NOT_STICKY;
        }
        // The distance so far, when carrying on after a restart.
        for (Trip.Point p : TripStore.read(TripStore.current(this))) thinner.accept(p);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            else startForeground(NOTIFICATION, notification());
        } catch (Throwable e) {
            App.log(this, "trip: couldn't go to the foreground (" + e + "); kept the trip so far");
            TripStore.finish(this);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            App.log(this, "trip: no precise location");
            return START_STICKY;
        }
        manager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        try {
            manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, this, Looper.getMainLooper());
            App.log(this, "trip: recording" + (thinner.count() > 0 ? ", carrying on after " + thinner.count() + " points" : ""));
        } catch (Throwable e) {
            App.log(this, "trip: GPS failed: " + e);
        }
        return START_STICKY;
    }

    @Override
    public void onLocationChanged(Location l) {
        // A fix that comes in after Stop ended the trip (the service stops a moment later).
        if (TripStore.started(this) != started) return;
        if (l.hasAccuracy() && l.getAccuracy() > MAX_ACCURACY_M) return;
        Trip.Point p = new Trip.Point(l.getLatitude(), l.getLongitude(), l.getTime());
        if (!thinner.accept(p)) return;
        try (FileWriter w = new FileWriter(TripStore.current(this), true)) {
            w.write(p.line());
        } catch (IOException e) {
            App.log(this, "trip: couldn't write: " + e);
        }
        long now = System.currentTimeMillis();
        if (now - lastNotified > NOTIFY_MS) {
            lastNotified = now;
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIFICATION, notification());
        }
    }

    private Notification notification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        Notification.Builder n;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Trip recording", NotificationManager.IMPORTANCE_LOW));
            n = new Notification.Builder(this, CHANNEL);
        } else {
            n = new Notification.Builder(this);
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        // Stop goes through TripActivity, a screen: it may open the map with the trip.
        Intent stopIntent = new Intent(Intent.ACTION_VIEW, Uri.parse("garminmap://trip/stop"), this, TripActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent stop = PendingIntent.getActivity(this, 1, stopIntent, flags);
        PendingIntent map = PendingIntent.getActivity(this, 2, new Intent(this, ChromeLauncher.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags);
        long minutes = (System.currentTimeMillis() - started) / 60_000;
        String so = String.format(Locale.ROOT, "%.1f km so far · %d min", thinner.metres() / 1000, minutes);
        return n.setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Recording your trip")
            .setContentText(so)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(map)
            .addAction(new Notification.Action.Builder(null, "Stop", stop).build())
            .addAction(new Notification.Action.Builder(null, "Open map", map).build())
            .build();
    }

    @Override
    public void onDestroy() {
        if (manager != null) manager.removeUpdates(this);
        manager = null;
        stopForeground(true);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {}

    @Override
    public void onProviderDisabled(String provider) {}
}
