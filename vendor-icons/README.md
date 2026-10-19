# vendor-icons

Locally generated vendor icon libraries that must **not** be committed. Everything in this folder
except this README is gitignored.

## `aws-icons.json` (jmuir-dtu.29)

The real AWS Architecture Icons. This repo is public, and AWS's published terms only explicitly
cover using the icons to create architecture diagrams, so the artwork isn't bundled in source.
Without this file the app uses the placeholder AWS icons in
`packages/diagram-core/src/libraries/aws-icons.ts`.

To generate it:

1. Download the **Icon package** zip from <https://aws.amazon.com/architecture/icons/> and unzip it
   anywhere outside the repo.
2. From the repo root:

   ```bash
   node packages/diagram-core/scripts/generate-aws-icons.mjs <unzipped>/Architecture-Service-Icons_<release>
   ```

   This writes `vendor-icons/aws-icons.json`.
3. Run the catalog seed (`npm run seed:catalog --workspace=@canvas/api`) to load it locally. On
   Azure, `deploy.sh` builds the API image from the working tree, which copies this folder, and its
   catalog-seed job loads the file.

The seed looks for the file here by default; set `AWS_ICONS_MANIFEST` to use another path.
