# Corpus

Drop photographs in here and list them in `index.json`. The trainer
(`tools/train.mjs`) loads whatever is listed, plus generated scenes, and sweeps
the objective's constants across all of them.

Real photographs matter more than the generated ones. Flat patches of six
colours are not a photograph: a real frame carries shading, so every surface
spreads into dozens of nearby colours. The first synthetic scenes disagreed
sharply with the one real photo we had, and the real photo was right.

Nothing is committed here — these are somebody's pictures. `index.json` is
committed as the manifest, so `git clone` gets an empty corpus even though the
trainer has been run against 15: refetch or re-drop images matching that list
before re-running `tools/train.mjs`, or the sweep silently falls back to
generated-only.
