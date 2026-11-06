import { interfaceSizeLabel, type SettingsSnapshot } from '@shared/space-api'
import { changeSettings } from '../../lib/settings'
import { Select } from '../Select'
import { SettingRow } from './parts'

/** Settings > General: Interface Size and Show performance, the same settings as the View menu's items. */
export function GeneralSection({ general }: { general: SettingsSnapshot['general'] }) {
  return (
    <>
      <SettingRow name="Interface size" description="The size of text and controls; the board keeps its own zoom">
        <Select
          label="Interface size"
          value={String(general.interfaceSize)}
          options={(['auto', ...general.interfaceSizes] as const).map((size) => ({ value: String(size), label: interfaceSizeLabel(size, general.automaticSize) }))}
          onChange={(size) => changeSettings({ interfaceSize: size === 'auto' ? 'auto' : Number(size) })}
        />
      </SettingRow>
      <SettingRow name="Show performance" description="The board's frame rate and drawing time in the top bar">
        <button
          className="menu__switch"
          role="switch"
          aria-checked={general.showPerformance}
          aria-label="Show performance"
          onClick={() => changeSettings({ showPerformance: !general.showPerformance })}
        />
      </SettingRow>
    </>
  )
}
