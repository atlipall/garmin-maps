package is.atlipall.garminmap;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Where a trip lives on the device. The one being recorded: `trip.csv` and the start time in the
 * "trip" preferences. A finished one: `trips/trip-<start>-<end>.csv`, kept (the last few) until
 * the map has it for sure, so a hand-over that didn't arrive can be sent again from the log screen.
 */
final class TripStore {
    private TripStore() {}

    private static final String FILE = "trip.csv";
    private static final String DIR = "trips";
    private static final String PREFS = "trip";
    private static final int KEEP_FINISHED = 5;
    /** More points than this are thinned before the hand-over: the trip travels in an Intent and an
     *  address, and about 8 bytes a point must stay well under Android's 1 MB for an Intent. */
    static final int MAX_POINTS = 40_000;

    static File current(Context c) {
        return new File(c.getFilesDir(), FILE);
    }

    /** When the trip being recorded started (ms), or 0 when none is. */
    static long started(Context c) {
        return prefs(c).getLong("started", 0);
    }

    /** A new trip from now on. One left over (the app was force-stopped, the unit restarted) is
     *  finished first, so it can still be sent and never runs into the new one. */
    static long begin(Context c) {
        if (started(c) != 0) {
            File old = finish(c);
            App.log(c, "trip: a trip left over was kept as " + (old == null ? "nothing" : old.getName()));
        }
        long start = System.currentTimeMillis();
        current(c).delete();
        prefs(c).edit().putLong("started", start).apply();
        return start;
    }

    /** Ends the trip being recorded: kept as a finished trip (null when there was none). */
    static File finish(Context c) {
        long start = started(c);
        prefs(c).edit().remove("started").apply();
        if (start == 0) return null;
        File dir = new File(c.getFilesDir(), DIR);
        dir.mkdirs();
        File done = new File(dir, "trip-" + start + "-" + System.currentTimeMillis() + ".csv");
        File cur = current(c);
        if (!cur.exists() || !cur.renameTo(done)) {
            try {
                Files.write(done.toPath(), new byte[0]);
            } catch (IOException e) {
                return null;
            }
        }
        // The last few only.
        File[] all = dir.listFiles();
        if (all != null && all.length > KEEP_FINISHED) {
            Arrays.sort(all);
            for (int i = 0; i < all.length - KEEP_FINISHED; i++) all[i].delete();
        }
        return done;
    }

    /** The most recent finished trip, if any. */
    static File last(Context c) {
        File[] all = new File(c.getFilesDir(), DIR).listFiles();
        if (all == null || all.length == 0) return null;
        Arrays.sort(all);
        return all[all.length - 1];
    }

    static List<Trip.Point> read(File file) {
        List<Trip.Point> out = new ArrayList<>();
        if (file == null || !file.exists()) return out;
        try {
            for (String line : Files.readAllLines(file.toPath(), StandardCharsets.UTF_8)) {
                Trip.Point p = Trip.Point.parse(line);
                if (p != null) out.add(p);
            }
        } catch (IOException ignored) {
            // what was read so far
        }
        return out;
    }

    /** Every n-th point (and the last), when there are more than `max`. */
    static List<Trip.Point> fit(List<Trip.Point> points, int max) {
        if (points.size() <= max) return points;
        int step = (points.size() + max - 1) / max;
        List<Trip.Point> out = new ArrayList<>();
        for (int i = 0; i < points.size(); i += step) out.add(points.get(i));
        if (out.get(out.size() - 1) != points.get(points.size() - 1)) out.add(points.get(points.size() - 1));
        return out;
    }

    /** Opens the map with a finished trip in its address, for it to keep (the map ignores a trip it
     *  already has). Called from an activity in front, which Android allows to open the map. */
    static void handOver(Context c, File finished) {
        String[] parts = finished.getName().replace(".csv", "").split("-");
        long start = Long.parseLong(parts[1]);
        long end = Long.parseLong(parts[2]);
        List<Trip.Point> points = fit(read(finished), MAX_POINTS);
        App.log(c, "trip: handing " + points.size() + " points to the map");
        openMap(c, Trip.toFragment(start, end, points));
    }

    /** Opens the map with `fragment` after the `#` of its address. */
    static void openMap(Context c, String fragment) {
        Intent open = new Intent(c, ChromeLauncher.class);
        open.setData(Uri.parse(BuildConfig.START_URL + "#" + fragment));
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        c.startActivity(open);
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
