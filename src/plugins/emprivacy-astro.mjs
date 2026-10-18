/**
 * Substitute for `@emplugins/emprivacy/astro`.
 *
 * EmPrivacy 3.2.0 publishes that entry as unbuilt TypeScript that imports a
 * module the package never ships (`../security.js`), which fails the production
 * build. Its only purpose is consent-gated YouTube/Vimeo/embed placeholders.
 * This site does not use EmDash embed blocks, so an empty component map is
 * equivalent and the cookie-consent banner (served by the plugin's main entry)
 * is unaffected.
 */
export const blockComponents = {};
