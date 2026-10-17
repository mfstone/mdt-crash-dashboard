# Reference geometry

Montana county boundaries and incorporated-place points, shipped with the repo
rather than downloaded.

| File | Features | Size | Geometry |
|---|---|---|---|
| `counties.geojson` | 56 | 161 KB | polygons, `NAME` + `ALLFIPS` |
| `places.geojson` | 127 | 14 KB | points, `NAME` |

Both are WGS84 and already simplified for display — these frame the crash data
at state and county zoom, they are not for measurement. Full-precision
boundaries would outweigh the crash data they exist to frame.

They are committed, and that is the point: the dashboard's reference layer then
depends on no server staying up and no extra download. Derived from Montana
state GIS public boundary data; they change on a timescale of decades.

Replacing them is a supported operation — drop in any GeoJSON with a `NAME`
property per feature and the build will use it. That is how this tool would be
pointed at another state.
