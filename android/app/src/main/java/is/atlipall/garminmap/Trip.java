package is.atlipall.garminmap;

import java.util.List;
import java.util.Locale;

/**
 * A recorded trip's points, how they are thinned while recording, and how the trip is handed to the
 * map: in the address after `#` (nothing goes online), as
 * `trip=1.<start ms>.<end ms>.<points>.<seconds>` where <points> is the Google encoded-polyline form
 * of the coordinates (5 decimals, about 1 m) and <seconds> the same encoding of each point's seconds
 * after the previous one. Both use only characters 63-126; those that aren't safe in an address are
 * %-escaped. web/src/tracks/trip.ts reads it.
 */
final class Trip {
    private Trip() {}

    static final class Point {
        final double lat;
        final double lon;
        final long time;

        Point(double lat, double lon, long time) {
            this.lat = lat;
            this.lon = lon;
            this.time = time;
        }

        String line() {
            return String.format(Locale.ROOT, "%d,%.6f,%.6f\n", time, lat, lon);
        }

        static Point parse(String line) {
            String[] f = line.split(",");
            if (f.length != 3) return null;
            try {
                return new Point(Double.parseDouble(f[1]), Double.parseDouble(f[2]), Long.parseLong(f[0]));
            } catch (NumberFormatException e) {
                return null;
            }
        }
    }

    /** Keeps a point about every 10 m, or after 3 m when the way turns by 20° or more. */
    static final class Thinner {
        private static final double KEEP_M = 10;
        private static final double TURN_M = 3;
        private static final double TURN_DEG = 20;
        private Point last;
        private double heading = Double.NaN;
        private double metres;
        private int count;

        /** Whether to keep this point (and if so, it counts as the last one kept). */
        boolean accept(Point p) {
            if (last == null) return keep(p, Double.NaN, 0);
            double d = metresBetween(last, p);
            double h = bearing(last, p);
            boolean turned = !Double.isNaN(heading) && d >= TURN_M && Math.abs(angle(h - heading)) >= TURN_DEG;
            if (d < KEEP_M && !turned) return false;
            return keep(p, h, d);
        }

        private boolean keep(Point p, double h, double d) {
            last = p;
            heading = h;
            metres += d;
            count++;
            return true;
        }

        double metres() {
            return metres;
        }

        int count() {
            return count;
        }
    }

    static double metresBetween(Point a, Point b) {
        double rad = Math.PI / 180;
        double dLat = (b.lat - a.lat) * rad;
        double dLon = (b.lon - a.lon) * rad;
        double h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    static double bearing(Point a, Point b) {
        double rad = Math.PI / 180;
        double y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
        double x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
        return Math.atan2(y, x) / rad;
    }

    /** An angle brought into -180..180. */
    static double angle(double deg) {
        double a = ((deg % 360) + 540) % 360 - 180;
        return a;
    }

    static String toFragment(long start, long end, List<Point> points) {
        StringBuilder coords = new StringBuilder();
        StringBuilder secs = new StringBuilder();
        long pLat = 0, pLon = 0, pT = start / 1000;
        for (Point p : points) {
            long lat = Math.round(p.lat * 1e5);
            long lon = Math.round(p.lon * 1e5);
            encode(lat - pLat, coords);
            encode(lon - pLon, coords);
            long t = p.time / 1000;
            encode(t - pT, secs);
            pLat = lat;
            pLon = lon;
            pT = t;
        }
        return "trip=1." + start + "." + end + "." + escape(coords) + "." + escape(secs);
    }

    /** One signed number in the encoded-polyline form. */
    static void encode(long v, StringBuilder out) {
        long s = v < 0 ? ~(v << 1) : v << 1;
        while (s >= 0x20) {
            out.append((char) ((0x20 | (s & 0x1f)) + 63));
            s >>= 5;
        }
        out.append((char) (s + 63));
    }

    /** %-escapes what isn't safe in an address fragment (the polyline alphabet's `[ \ ] ^ ` { | }`). */
    static String escape(CharSequence s) {
        StringBuilder out = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '?' || c == '@' || c == '_' || c == '~') out.append(c);
            else out.append('%').append(String.format(Locale.ROOT, "%02X", (int) c));
        }
        return out.toString();
    }
}
