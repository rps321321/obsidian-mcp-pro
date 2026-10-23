# Installed package acceptance

Run `node scripts/check-packed-consumer.mjs` from a checkout with dependencies installed. It builds and packs the core, installs the tarball with production dependencies into a fresh temporary consumer, and runs the CLI and documented library imports from that consumer. It does not import the checkout's source or build directory. The temporary consumer and vault are removed when the run finishes, including on failure.

The probe uses Node 24 and checks stdio reads, a bounded append, normalized move paths and link targets, concurrent HTTP sessions, session termination and reconnect, cross-session reads after a write, and shutdown. It checks replacement-write permissions on POSIX systems. Directory alias checks use symlinks on POSIX and junctions on Windows; creation failures caused by unavailable capabilities are reported in the result rather than treated as successful alias coverage.

Run the probe on native Windows, macOS and Linux to test each platform's filesystem behavior. A Linux container run does not establish Windows or macOS behavior. The output records the Node version, operating system, successful alias fixtures and whether POSIX permission checks ran. Node versions below the package's declared minimum are unsupported; later Node versions require their own runtime verification.

This probe exercises a synthetic vault and actual installed core transports. It does not establish behavior inside a running Obsidian plugin, qualification of an external model, or production deployment configuration. The source test suite remains responsible for fault injection and detailed boundary cases.
