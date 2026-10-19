#!/bin/sh
# First start: prepare the routing graph from the baked-in extract into the volume (/data).
# Later starts: serve it. To refresh the map, delete /data/uzbekistan-latest.osrm* and redeploy
# after rebuilding the image (the .pbf is downloaded at build time).
set -eu
DATA=/data
GRAPH="$DATA/uzbekistan-latest.osrm"

if [ ! -f "$GRAPH.mldgr" ]; then
  echo "osrm: preparing graph (one time)"
  cp /opt/uzbekistan-latest.osm.pbf "$DATA/uzbekistan-latest.osm.pbf"
  osrm-extract -p /opt/car.lua "$DATA/uzbekistan-latest.osm.pbf"
  osrm-partition "$GRAPH"
  osrm-customize "$GRAPH"
  rm -f "$DATA/uzbekistan-latest.osm.pbf"
fi

exec osrm-routed --algorithm mld --max-table-size 1000 --ip 0.0.0.0 --port "${PORT:-5000}" "$GRAPH"
