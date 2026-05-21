# Operator Guide

Start with `docker compose up --build`, then run `tanren doctor` and `tanren hello` through the CLI package.

After the generated Drizzle baseline migration lands, existing local hello-world databases from the earlier hand-written baseline should be reset with `docker compose down -v` before running the smoke again.
