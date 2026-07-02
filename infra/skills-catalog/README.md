# UCSD Skills Catalog

Temporary Cloudflare Pages/static catalog for TritonAI Harness skills.

## Shape

- `public/catalog.json` lists available skills and their section metadata.
- `public/skills/<id>.json` contains a bundle with relative file paths and file contents.
- The app reads `T3CODE_SKILL_CATALOG_URL` when set, otherwise it tries
  `https://tritonai-skills-catalog.pages.dev/catalog.json`.
- The server includes a bundled fallback generated from the same source so local development works
  before the Cloudflare site is deployed.

## Regenerate

```sh
UCSD_SKILL_CATALOG_GENERATED_AT=2026-06-19T00:00:00.000Z node scripts/generate-ucsd-skill-catalog.mjs
```

Set `UCSD_SKILLS_LIBRARY=/path/to/UCSD-Skills-Library` if the source repository is not next to this
worktree.
