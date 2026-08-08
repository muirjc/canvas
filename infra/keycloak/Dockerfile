# Keycloak with the CanvasRealm realm baked in (canvas-ycu.1).
#
# Bakes CanvasRealm-realm.json into the image rather than mounting it via an Azure Files volume --
# avoids provisioning a storage account + file share just for one static config file, given ACR +
# `az acr build` already work for this repo's other images. `start --import-realm` skips the
# import if the realm already exists, so re-deploying this image is safe against an existing
# server.
FROM quay.io/keycloak/keycloak:26.2

# Keycloak's dir importer requires the filename to match `<realm-name>-realm.json` exactly -- the
# realm inside is named "CanvasRealm", so the file must be named CanvasRealm-realm.json (not
# canvasrealm-realm.json or similar), or the server refuses to start with "File name / realm name
# mismatch".
COPY CanvasRealm-realm.json /opt/keycloak/data/import/CanvasRealm-realm.json
