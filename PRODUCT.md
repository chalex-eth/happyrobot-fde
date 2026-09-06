# Carrier sales POC

## Platform
web — existing Next.js application.

## Users and purpose
Callers speak to a carrier-sales agent. Brokerage operators inspect calls, load
coverage and follow-up requests. A compact web-call demo and real operator data
share the page. The operator dashboard opens directly without a password, as requested.

## Confirmed constraints
Twin owns call activity. TMS supplies live load inventory. MC 135797, Salt Lake
City departure and a $2,700 counter are the requested demo cues. Screen OTP stays
near the call controls. Detailed verification/booking states belong to operators.
Current test bookings remain simulated and explicitly identified in operator data.
M5 starts small: demo banner, map/load list, calls and a review queue covering
callbacks, technical errors and other reasons. Sentiment and large analytics are
deferred. HappyRobot Apps hosting remains a later deployment requirement.

The operator map covers TMS lanes across US origins and displays equipment type.
Salt Lake City is solely the caller's suggested spoken city, never a map filter.
