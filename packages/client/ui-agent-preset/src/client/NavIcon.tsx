/** Nav glyph of the agent preset settings section, contributed to `settings.nav.icon`. */
import { IconAgentPresetOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the agent preset section's nav glyph.
 * @returns the 16px icon element the settings shell places before the section label.
 */
export function AgentPresetNavIcon() {
  return <IconAgentPresetOutline16 size={16} />
}
