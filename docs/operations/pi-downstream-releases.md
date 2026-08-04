# Pi downstream releases

The private fork keeps `upstream` pointed at `pingdotgg/t3code`, `origin` pointed at the private fork,
and `pi/main` as the latest integration branch. The repository default branch must contain the
compatibility workflow (normally by making `pi/main` the default), because GitHub runs scheduled
workflows only from the default branch.

`.github/workflows/pi-upstream-compat.yml` checks daily and can also be dispatched for a specific tag.
For each unseen stable upstream tag it:

1. checks out the exact upstream tag
2. cherry-picks the five commits identified by `Pi-Patch` trailers
3. runs the focused Pi and provider-registry tests
4. typechecks contracts, server, and web
5. builds the web app and bundled server
6. packages a private CLI whose executable is `t3-pi`
7. publishes a uniquely tagged GitHub release and compatibility manifest

The workflow never certifies nightlies. A failure publishes no release and leaves the previous release
untouched. It opens an issue with the upstream tag, workflow failure, changed-file artifact, and last
known certified release.

Before pushing an integration update, rebase the five commits onto current upstream main and confirm
that each ordinal occurs exactly once. Do not squash the series unless the five trailers and boundaries
are recreated afterward.
