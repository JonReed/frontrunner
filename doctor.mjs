#!/usr/bin/env node

/**
 * Stable public entry point for the setup doctor.
 *
 * Implementation lives with the application boundary so the repository root
 * remains a command surface rather than an implementation directory.
 */

import './src/application/doctor.mjs';
