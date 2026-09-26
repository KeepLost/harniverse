# Agent Note: Harniverse RC frontend branding

Status: implemented

English | [中文](2026-09-25-harniverse-rc-frontend-branding.zh.md)

## Problem

The browser client, authentication documents, install metadata, and documentation site need one Harniverse RC presentation without changing provider identities, package names, environment variables, or the plugin-native composition model. The inherited fish mark does not represent the approved product artwork, and the welcome notice still describes the earlier product stage.

## Decision

The browser-owned assets are the supplied 1254×1254 SVG variants in `apps/web/public/`: the non-transparent `whale-logo.svg` renders in both authentication documents, `whale-logo-light.svg` renders in the blank-session hero against the current light surface, and `whale-logo-transparent.svg` ships for the future dark theme. The sidebar brand and browser tab use `whale-logo.ico`. The PWA manifest uses `whale-logo-light.svg`, so the Web entry has no product PNG logo dependency.

The sidebar keeps its accessible, layout-owned panel toggle in the collapsed rail and renders `whale-logo.ico` as the expanded New Session brand button. Authentication headers use the non-transparent artwork and the Harniverse product label; the post-authentication boot loading page and blank-session Hero use the light transparent artwork, while the desktop blue H remains unchanged.

The product-owned welcome notice is bilingual Harniverse RC copy with acknowledgement version `2026-09-25.1`; that acknowledgement version is independent from package and product versions. Provider names, model ids, API-key labels, environment variables, package names, and internal identifiers retain their existing contracts.

This note owns the presentation decision only. The [browser authentication lifecycle note](../architecture/2026-09-08-browser-authentication-lifecycle.md) continues to own authentication state and status placement, the [Web install manifest note](2026-08-06-web-install-manifest.md) continues to own install semantics, and the [documentation-site chrome note](../process/2026-08-12-documentation-site-navigation-and-chrome.md) continues to own VitePress navigation and chrome behavior. Their former branding facts are partially superseded by this note; their remaining contracts stay active.

## Alternatives considered

**A small simplified glyph:** Rejected because the approved source is a complete square composition and the install icons must preserve that composition by resize only.

**Keep the inherited fish mark beside the new artwork:** Rejected because it leaves an official mark in the client and creates two competing product identities.

**Generate a separate artwork for each surface:** Rejected because one repository-owned source keeps the hero, authentication pages, and PWA install metadata visually consistent without introducing a logo-generation system.

## Consequences

The unauthenticated web shell serves one root-relative artwork URL before plugin loading, so authentication and hero pages do not depend on an authenticated route or plugin asset. Fixed image dimensions reserve layout space, and the artwork remains available in light and dark themes because its presentation does not depend on a theme-specific SVG mark. At the authentication sheet's existing phone breakpoint, the artwork is 88×88 and management actions occupy a separate full-width header row.

The expanded sidebar brand button shows the ICO logo and retains its New Session action; the collapsed rail keeps its panel-toggle control. The Web entry declares the ICO as its browser-tab favicon, and the PWA manifest uses the light transparent SVG. The welcome notice intentionally reappears for existing users once because its meaning changed; the mirrored host copy and client copy carry the same version and text. Built-Web and browser acceptance checks verify all shipped logo assets and their authentication, hero, sidebar, favicon, and manifest references after the web dist is produced.

## Verification

The shipped SVGs identify as 1254×1254 vector artwork and the ICO carries the multi-size browser icon bundle. Focused client suites cover the sidebar ICO reference, hero artwork URL, authentication artwork and label, resident composer behavior, and exact bilingual notice copy. Built-Web verification requires a freshly produced web dist: the PWA tests check install metadata, SVG/ICO assets, and the favicon link; assembled browser checks verify the artwork before and after authentication and the responsive layout in light and dark themes.
