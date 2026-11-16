# calibration/ — private golden cases (user layer)

Real JDs whose evaluation was miscalibrated once, with the report and CV payload
snapshots and the verdict they should get. Everything here except this README is
gitignored: it holds your CV content, comp targets and client names.

    node calibrate.mjs add <name> --jd <file> --decision apply|consider|skip [--fit 4.0-5.0] [--priority high] \
      [--report reports/NNN-x.md] [--cv /tmp/cv-<candidate>-<slug>.json] [--url <url>] --note "why"
    node calibrate.mjs rerun <name>        # prints the command to re-queue the JD
    node calibrate.mjs snapshot <name> --report reports/<new>.md [--cv ...]
    node calibrate.mjs check calibration   # also runs (warn-only) inside test-all.mjs
    node calibrate.mjs table calibration   # before/after numbers only, safe to share

Cases use the real config/profile.yml and cv.md (`context: real`). The public,
synthetic set that runs in CI is tests/calibration/. See docs/evaluation-rules.md.
