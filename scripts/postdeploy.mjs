#!/usr/bin/env node
// Pacioli — post-deploy checklist. Runs automatically after `npm run deploy` (npm's `postdeploy`
// hook), so the two follow-ups a CLI deploy needs are printed, not remembered. Zero dependencies.

console.log(`
deploy: done. Two follow-ups:

1. Vercel CLI deploys can auto-create an extra personal-scope alias alongside the project domain.
   List the aliases and remove any personal-scope one you did not intend to publish:

     vercel alias ls
     vercel alias rm <personal-scope-alias>

2. Verify parity took (this is what the deploy-parity workflow asserts on every push to main):

     curl -s https://pacioliapp.vercel.app/api/version

   The "sha" must equal the commit you just deployed (git rev-parse HEAD).
`);
