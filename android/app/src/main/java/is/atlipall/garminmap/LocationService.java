package is.atlipall.garminmap;

import com.google.androidbrowserhelper.locationdelegation.LocationDelegationExtraCommandHandler;
import com.google.androidbrowserhelper.trusted.DelegationService;

/**
 * Location for the app in Chrome: in a Trusted Web Activity Chrome doesn't ask for location
 * itself but hands the question to the app, which asks Android (once) and passes the position on.
 * Without this service the map gets no location there, though Chrome as a browser does.
 */
public class LocationService extends DelegationService {
    public LocationService() {
        registerExtraCommandHandler(new LocationDelegationExtraCommandHandler());
    }
}
