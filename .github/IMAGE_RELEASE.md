# Generic Kit image release asset

The `Kit image release asset` workflow builds an exact 40-character source SHA on native `linux/amd64`. It defaults to `image_target=runtime`: Node only, with no Python, speech environment or model. Its network-isolated smoke checks assets, text report creation/readback, disabled voice, rejected speech drafts and absent speech dependencies.

The optional `image_target=speech` builds the pinned offline Russian recognizer and tests generated Russian speech with a 1 GiB RAM limit, a 3 GiB combined RAM-plus-swap limit and one CPU. It also requires explicit server project and widget voice opt-in; selecting an image does not enable recording for every project.

A manual run packages the selected image as `bug-report-kit-TARGET-linux-amd64-SHA.tar` and a manifest containing `imageTarget`, source SHA, image ID, platform, archive size/hash. Only the speech manifest includes the pinned public model revision. The publish job has repository-scoped contents:write; build/test steps have contents:read. Publication requires an existing stable release tag matching the requested source SHA, rejects an existing matching asset and never uses --clobber.

Assets contain no project configuration, credentials or user audio. Model dependencies download only during an explicitly selected speech build; users' requests never install a model. Version0.4.1 runtime archive is236,170,240bytes; its exact digest and rollout receipts are in [the rollout record](../docs/rollout-2026-10-27.md).
