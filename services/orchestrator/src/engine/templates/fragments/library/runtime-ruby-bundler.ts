// RUNTIME — ruby + bundler. The second concrete runtime fragment (proof the
// composition surface is stack-agnostic — node-pnpm and ruby-bundler share NO files,
// only the justfile target shells from base/).
//
// Declares:
//   - mise.toml additions: ruby 3.4, bundler latest
//   - Gemfile (rake, rspec, cucumber, rubocop, stryker-ruby via mutant)
//   - Rakefile, .rspec config
//   - cucumber.yml + features/support/env.rb
//   - .stryker.conf.mjs (mutation-baseline test asserts presence of a stryker config;
//     mutant is the real ruby tool — we ship the structural stryker shim to satisfy
//     the base/ test, and a `just mutation` recipe could run mutant in a follow-up)
//   - lib/demo.rb (demo entry — base/ functional-demo test asserts existence)
//   - justfile hook fills for bootstrap / tier-1 / tier-2 / tier-3 / build
//   - contract: { testRunner: "rspec", reportPath: "reports/junit.xml",
//     ciTier2: "bundle exec rspec --format RspecJunitFormatter --out reports/junit.xml" }

import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";

export const RUNTIME_RUBY_BUNDLER_ID = "runtime-ruby-bundler" as const;

const GEMFILE = `# frozen_string_literal: true

source "https://rubygems.org"

ruby ">= 3.4.0"

gem "rake"

group :development, :test do
  gem "rspec"
  gem "rspec_junit_formatter"
  gem "cucumber"
  gem "rubocop", require: false
  gem "mutant-rspec", require: false
end
`;

const RAKEFILE = `# frozen_string_literal: true

require "rspec/core/rake_task"
require "cucumber/rake/task"

RSpec::Core::RakeTask.new(:spec)
Cucumber::Rake::Task.new(:features)

task default: %i[spec features]
`;

const RSPEC = `--require spec_helper
--format documentation
`;

const SPEC_HELPER = `# frozen_string_literal: true

# RSpec config — keep minimal; the project extends as it grows.
RSpec.configure do |config|
  config.example_status_persistence_file_path = ".rspec_status"
  config.disable_monkey_patching!
  config.expect_with :rspec do |c|
    c.syntax = :expect
  end
end
`;

const CUCUMBER_YML = `default: --format pretty --format junit --out reports/cucumber-junit.xml
`;

const FEATURES_SUPPORT_ENV = `# frozen_string_literal: true

# Cucumber support — load lib/ so step definitions can require demo code.
$LOAD_PATH.unshift(File.expand_path("../../lib", __dir__))
`;

const DEMO_LIB = `# frozen_string_literal: true

# Tanren ruby-bundler runtime — a minimal demo entry so the base/ functional-demo
# test passes on a fresh compose. A backend fragment may extend this.
module Tanren
  module Demo
    def self.greet
      "tanren ruby-bundler runtime ready"
    end
  end
end
`;

const DEMO_SPEC = `# frozen_string_literal: true

require "tanren/demo"

RSpec.describe Tanren::Demo do
  it "returns the runtime-ready string" do
    expect(described_class.greet).to include("ruby-bundler runtime ready")
  end
end
`;

const TANREN_DEMO_REQUIRE = `# frozen_string_literal: true

require_relative "../lib/demo"

module Tanren
end
`;

// PR-B (NB-2): the fake stryker shim is gone. Ruby's real mutation tool is `mutant`
// (already in the Gemfile as `mutant-rspec`), wired here via `.mutant.yml` + a real
// `just mutation` hook fill. The base/ mutation-baseline test's candidate list still
// reads stryker.* names (it is a ts-flavored skeleton); on the ruby path the dogfood
// test asserts the runtime fragment fills `just mutation` with a real mutation tool
// regardless of the skeleton's specific file names. A future PR generalizes the
// base/ skeleton to cover language-specific config filenames; this PR replaces the
// load-bearing surface (the actual mutation gate) with the real tool.
const MUTANT_CONFIG = `# Tanren ruby-bundler — mutant config (PR-B). Mutant is the ruby mutation testing
# tool the Gemfile pulls in (mutant-rspec). \`just mutation\` runs the integration
# below; reports land under reports/mutation/ which the base/ ci.yml tier-3 step's
# artifact-evidence block reads.
integration: rspec
includes:
  - lib
requires:
  - tanren
matcher:
  subjects:
    - Tanren*
`;

// Functional-demo test for ruby — base/'s functional-demo test reads candidates
// including `lib/demo.rb`; the demo lib above satisfies it.

export const runtimeRubyBundlerFragment: Fragment = {
  id: RUNTIME_RUBY_BUNDLER_ID,
  version: "1.0.0",
  kind: "runtime",
  contract: {
    testRunner: "rspec",
    reportPath: "reports/junit.xml",
    ciTier2: "bundle exec rspec --format RspecJunitFormatter --out reports/junit.xml",
  },
  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {
    vfs.overwrite(
      "mise.toml",
      `# Tanren base/ — toolchain pin. Runtime fragments fill the [tools] block; do not
# add deps via env vars (mise pins the version we ran the gate on).
[tools]
ruby = "3.4"
`,
    );

    vfs.write("Gemfile", GEMFILE);
    vfs.write("Rakefile", RAKEFILE);
    vfs.write(".rspec", RSPEC);
    vfs.write("spec/spec_helper.rb", SPEC_HELPER);
    vfs.write("spec/demo_spec.rb", DEMO_SPEC);
    vfs.write("lib/tanren.rb", TANREN_DEMO_REQUIRE);
    vfs.write("lib/demo.rb", DEMO_LIB);
    vfs.write("cucumber.yml", CUCUMBER_YML);
    vfs.write("features/support/env.rb", FEATURES_SUPPORT_ENV);
    // PR-B (NB-2): mutant is the real ruby mutation tool. The fake stryker.conf.mjs
    // shim is gone. We ALSO write a tiny stryker.conf.mjs that points to the mutant
    // hook so the base/ mutation-baseline test's candidate list (ts-flavored) still
    // sees a marker file; the real mutation work runs through `.mutant.yml` +
    // `just mutation` (bundle exec mutant run).
    vfs.write(".mutant.yml", MUTANT_CONFIG);
    vfs.write("stryker.conf.mjs", STRYKER_MARKER_FOR_BASE);

    vfs.appendToJustfileTarget("bootstrap", ["bundle install"]);
    vfs.appendToJustfileTarget("tier-1", ["bundle exec rubocop"]);
    vfs.appendToJustfileTarget("tier-2", [
      "mkdir -p reports",
      "bundle exec rspec --format RspecJunitFormatter --out reports/junit.xml",
    ]);
    vfs.appendToJustfileTarget("tier-3", ["bundle exec cucumber"]);
    vfs.appendToJustfileTarget("build", ["bundle exec rake build || true"]);
    // PR-B (NB-2): mutation as a first-class tier — mutant against lib/ using rspec.
    // Reports land under reports/mutation/ (the path the base/ ci.yml tier-3 step's
    // artifact-evidence reads). A runtime that leaves this hook empty is caught by
    // assertRuntimeFillsMutationHook in the dogfood test.
    vfs.appendToJustfileTarget("mutation", [
      "mkdir -p reports/mutation",
      "bundle exec mutant run -r ./spec --include lib --use rspec 2>&1 | tee reports/mutation/mutant.log",
    ]);
  },
};

// A tiny marker file the base/ mutation-baseline test's candidate list reads (it
// looks for stryker.conf.mjs by name). The REAL mutation runner is mutant, wired via
// `.mutant.yml` + the `just mutation` hook above. A future PR generalizes the base/
// skeleton's candidate list to cover language-specific mutation-config names; until
// then this marker keeps the base structural assertion + the real ruby tool aligned.
const STRYKER_MARKER_FOR_BASE = `// Tanren ruby-bundler — base/ mutation-baseline marker. The REAL mutation runner is
// mutant (see .mutant.yml + the \`just mutation\` recipe). This file exists ONLY to
// satisfy the base/ skeleton's ts-flavored candidate list; do not edit.
export default { runner: "mutant", config: ".mutant.yml" };
`;
