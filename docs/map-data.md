# Map data
The map uses derived US polygons from Natural Earth 1:110m country geometry
(public domain): https://www.naturalearthdata.com/about/terms-of-use/
Source: https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson
City coordinates are a US subset of GeoNames cities15000, downloaded 6 September
2026: https://download.geonames.org/export/dump/ (CC BY 4.0).
The derived files retain city/state lookup coordinates and projected polygon paths.
Endpoints are approximate city centers. Missing cities remain in the load list;
we do not guess or transmit load/caller data to a geocoding service. Alaska and
Hawaii appear as insets, so connecting lines represent lane relationships rather
than road geometry or distance. No live vehicle positioning is available.

Regenerate the checked-in subsets with `python3 scripts/prepare-map.py` from the repository root. This refreshes geographic reference data only; it is not needed at runtime.
