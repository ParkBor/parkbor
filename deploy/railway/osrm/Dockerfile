# OPTIONAL routing engine for Railway (docs/RAILWAY.md, "OSRM"). UNTESTED on Railway: heavy
# (first start extracts the Uzbekistan graph: ~2 GB RAM for a few minutes; runtime ~1 GB RAM).
# The backend works without it (routing endpoints degrade to a straight-line estimate).
# Railway: Root Directory "/deploy/railway/osrm", ONE volume at /data (>= 2 GB), private network only.
FROM alpine:3.20 AS pbf
RUN wget -q -O /uzbekistan-latest.osm.pbf https://download.geofabrik.de/asia/uzbekistan-latest.osm.pbf

FROM osrm/osrm-backend:v5.27.1
COPY --from=pbf /uzbekistan-latest.osm.pbf /opt/uzbekistan-latest.osm.pbf
COPY start.sh /usr/local/bin/parkbor-osrm-start
RUN chmod 0755 /usr/local/bin/parkbor-osrm-start
EXPOSE 5000
ENTRYPOINT ["parkbor-osrm-start"]
