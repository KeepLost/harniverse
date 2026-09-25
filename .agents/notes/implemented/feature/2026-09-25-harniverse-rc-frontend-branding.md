# Agent Note: Harniverse RC frontend branding

Status: implemented

English | [中文](2026-09-25-harniverse-rc-frontend-branding.zh.md)

## Problem

The browser client, authentication documents, install metadata, and documentation site need one Harniverse RC presentation without changing provider identities, package names, environment variables, or the plugin-native composition model. The inherited fish mark does not represent the approved product artwork, and the welcome notice still describes the earlier product stage.

## Decision

The browser-owned asset is the complete supplied artwork at `apps/web/public/harniverse-brand.png`, copied at its original 1254×1254 dimensions and rendered without cropping in the blank-session hero and both authentication documents. The PWA manifest uses resize-only 192×192 and 512×512 PNG copies of that same composition. The Web entry and documentation site deliberately declare no product favicon, and the inherited fish favicon files are removed.

The sidebar keeps its accessible, layout-owned panel toggle in the collapsed rail and renders the plain `Harniverse` wordmark as text when expanded. The `FishLogo` component and its public export are removed. Authentication headers use the artwork and the Harniverse product label, while the desktop blue H remains unchanged.

The product-owned welcome notice is bilingual Harniverse RC copy with acknowledgement version `2026-09-25.1`; that acknowledgement version is independent from package and product versions. Provider names, model ids, API-key labels, environment variables, package names, and internal identifiers retain their existing contracts.

This note owns the presentation decision only. The [browser authentication lifecycle note](../architecture/2026-09-08-browser-authentication-lifecycle.md) continues to own authentication state and status placement, the [Web install manifest note](2026-08-06-web-install-manifest.md) continues to own install semantics, and the [documentation-site chrome note](../process/2026-08-12-documentation-site-navigation-and-chrome.md) continues to own VitePress navigation and chrome behavior. Their former branding facts are partially superseded by this note; their remaining contracts stay active.

## Alternatives considered

**A small simplified glyph:** Rejected because the approved source is a complete square composition and the install icons must preserve that composition by resize only.

**Keep the inherited fish mark beside the new artwork:** Rejected because it leaves an official mark in the client and creates two competing product identities.

**Generate a separate artwork for each surface:** Rejected because one repository-owned source keeps the hero, authentication pages, and PWA install metadata visually consistent without introducing a logo-generation system.

## Consequences

The unauthenticated web shell serves one root-relative artwork URL before plugin loading, so authentication and hero pages do not depend on an authenticated route or plugin asset. Fixed image dimensions reserve layout space, and the artwork remains available in light and dark themes because its presentation does not depend on a theme-specific SVG mark. At the authentication sheet's existing phone breakpoint, the artwork is 88×88 and management actions occupy a separate full-width header row.

The collapsed rail has one functional panel-toggle control instead of a decorative fish resting state. The Web entry and documentation site have no product favicon, while the PWA manifest retains the complete-art PNG install icons. The welcome notice intentionally reappears for existing users once because its meaning changed; the mirrored host copy and client copy carry the same version and text. Built PWA and browser acceptance checks verify the copied assets and their 192/512 dimensions after the web dist is produced.

## Verification

The source and derived PNGs identify as 1254×1254, 192×192, and 512×512 sRGB PNGs. Focused client suites cover the plain wordmark, sidebar toggle, hero artwork URL, authentication artwork and label, resident composer behavior, and exact bilingual notice copy. Built-Web verification requires a freshly produced web dist: the PWA tests check install metadata, PNG dimensions, and absent favicon assets; assembled browser checks verify the artwork before and after authentication and the responsive layout in light and dark themes.
