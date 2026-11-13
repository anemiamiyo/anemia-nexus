# F18 scheduler

Three roots (`alpha`, `beta`, `gamma`) with declared package dependencies
(`beta -> alpha`, `gamma -> beta`). Used to verify the 5.10 dependency order,
the five-level degradation ladder, failure isolation, cancellation without a
partial commit, and retention of the previous index under a squeezed budget.
