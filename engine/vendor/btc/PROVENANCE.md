# Vendored: BTC-ISMIR19

Source: https://github.com/jayg996/BTC-ISMIR19 — "A Bi-Directional Transformer for Musical
Chord Recognition" (Park et al., ISMIR 2019). **MIT License** (see `LICENSE`), including the
committed pretrained weights.

Only the **inference** path is vendored (no training code). Files taken verbatim:
`btc_model.py`, `utils/{transformer_modules,hparams,mir_eval_modules,logger,__init__}.py`,
`run_config.yaml`, `weights/btc_model.pt` (majmin, 25 classes), `weights/btc_model_large_voca.pt`
(large vocabulary, 170 classes — extended chords). `pyrubberband` (training-only) is intentionally
NOT pulled in.

## Patches applied (only these — to run on a modern stack; preprocessing is otherwise untouched)

1. `utils/hparams.py`: `yaml.load(f)` → `yaml.load(f, Loader=yaml.FullLoader)` (PyYAML ≥ 6).
2. `utils/transformer_modules.py`: `np.float` → `float` (numpy ≥ 2 removed the alias).
3. The CPU/torch-version load fix (`map_location` + `weights_only=False`) lives in our wrapper
   `engine/engines/btc_engine.py`, not in the vendored files.

The CQT preprocessing, per-checkpoint mean/std normalization, 10 s windowing, and `n_timestep`
padding are part of the model and are reproduced exactly — do not "simplify" them. The
`tests/py/test_btc_fidelity.py` gate enforces that our output matches BTC's reference verbatim.
