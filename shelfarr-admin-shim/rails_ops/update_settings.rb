data = JSON.parse(File.read(ENV.fetch("SHIM_DATA_PATH")))

updated = {}
data.each do |key, value|
  SettingsService.set(key.to_sym, value)
  updated[key] = SettingsService.get(key.to_sym)
end

puts({ ok: true, updated: updated }.to_json)
