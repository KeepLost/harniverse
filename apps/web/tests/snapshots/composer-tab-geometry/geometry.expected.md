# Composer seat visibility across the Chat and Trajectory tabs

## Wide viewport (1680px, card at its cap)

- Chat: scrollbar-gutter stable, overflow hidden/auto
- Chat scroller scrolls: true
- Chat reserved band: 8px
- Chat composer seat display: flex
- Chat input card visible: true
- Trajectory: scrollbar-gutter auto, overflow hidden/auto
- Trajectory scroller scrolls: false
- Trajectory reserved band: 0px
- Trajectory composer seat display: none
- Trajectory input card visible: false
- seat node survived the tab round trip: true
- textarea node survived the tab round trip: true

## Narrow viewport (800px, card shrinking with the column)

- Chat composer seat display: flex
- Chat input card visible: true
- Chat card narrower than at the cap: true
