# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A self-hosting listener (single owner, plus whoever they share the instance with) who collects playlists from NetEase, QQ Music, YouTube and Bilibili into one library and plays them from desktop browsers and phones. Sessions are long: the Watch page stays open as the "now playing" surface while the user listens, glances at lyrics, reorders the queue, or switches between audio and video.

## Product Purpose

MeowSync unifies music from several providers into one player with reliable playback, synchronized lyrics (with cross-provider lyric matching that prefers no lyrics over wrong lyrics), server-side downloads/caching and multi-device sync and remote control. Success is uninterrupted listening with correct lyrics and a queue the user trusts.

## Positioning

One library and one queue across NetEase, QQ, YouTube and Bilibili, with audio/video switching for video-sourced tracks and lyric binding that works across artists and covers, self-hosted.

## Operating Context

- Desktop browser at 1280–1920px wide and phones (~390px portrait, occasionally landscape).
- The bottom player bar is the single source of transport, progress, volume and song title/artist; the Watch page must not duplicate song metadata (confirmed by the owner).
- Watch page panels: queue (待播), lyrics (歌词), related (相关); media area shows the cover (audio mode) or the muted, audio-clocked video (video mode).

## Capabilities and Constraints

- Vue 3 + Vite + Tailwind; global design tokens in `src/style.css`, themes via `:root[data-theme]` (`default` "retro" print-grid and `glitch-restoration`).
- Watch page (owner decision 2026-05): uses an immersive dark stage where the cover art supplies ambient colour (YouTube Music player-page language); the rest of the app keeps its print-grid world.
- Interface language is Simplified Chinese.
- `FullscreenPlayer` immersive lyrics view is visually frozen.

## Brand Commitments

- Name: MeowSync. Playful "喵" voice in empty/loading copy.
- Owner dislikes faint tinted panel backgrounds in the Watch side area (explicitly asked to remove them twice).

## Product Principles

1. Wrong lyrics are worse than no lyrics.
2. Playback is never interrupted by UI state changes.
3. Every action has one obvious home; no duplicated controls between page and player bar.
4. Mobile is a first-class surface, not a squeezed desktop.
