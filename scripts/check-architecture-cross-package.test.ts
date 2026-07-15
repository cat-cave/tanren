import { describe, expect, it } from "vitest";
import { checkCrossPackageDeepImports } from "./check-architecture-structure.mjs";

describe("cross-package deep import checker", () => {
  it("flags deep cross-package imports across real dependency forms", () => {
    const deep = "@tanren/db/src/stateEnums.js";
    const main = [
      `import { x } from "${deep}";`,
      `export { x } from "${deep}";`,
      `const x = require("${deep}");`,
      `const x = import("${deep}");`,
      `import x = require("${deep}");`,
      `import type { X } from "${deep}";`,
      `type Y = import("${deep}").X;`,
    ].join("\n");
    const flagged = checkCrossPackageDeepImports([
      { file: "services/orchestrator/src/main.ts", text: main },
      {
        file: "services/orchestrator/tests/sample.test.ts",
        text: 'import { x } from "../../../db/src/stateEnums.js";\n',
      },
    ]);
    expect(flagged).toHaveLength(8);
    expect(flagged.every((item) => item.rule === "cross-package-deep-import")).toBe(true);
    expect(flagged.map((item) => item.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 1]);
  });

  it("ignores deep-import lookalikes outside dependency syntax", () => {
    const lookalikes = {
      file: "services/orchestrator/src/main.ts",
      text: '// import { x } from "@tanren/db/src/stateEnums.js";\nconst prose = "require(\\\"@tanren/db/src/stateEnums.js\\\")";\nconst template = `export { x } from "@tanren/db/src/stateEnums.js"`;\nconst malformed = from "@tanren/db/src/stateEnums.js";\n',
    };
    expect(checkCrossPackageDeepImports([lookalikes])).toEqual([]);
  });

  it("allows public-entry and intra-package imports", () => {
    const file = "services/orchestrator/src/main.ts";
    expect(
      checkCrossPackageDeepImports([
        { file, text: 'import { stateEnumLists } from "@tanren/db";\n' },
        { file, text: 'import { y } from "./engine/state/index.js";\n' },
      ]),
    ).toEqual([]);
  });
});
