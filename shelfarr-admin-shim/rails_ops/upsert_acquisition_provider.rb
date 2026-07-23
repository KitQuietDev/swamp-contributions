data = JSON.parse(File.read(ENV.fetch("SHIM_DATA_PATH")))

ap_ = AcquisitionProvider.find_or_initialize_by(name: data.fetch("name"))
ap_.assign_attributes(
  url: data.fetch("url"),
  api_key: data["api_key"],
  allow_private_network: data.fetch("allow_private_network", false),
  supports_audiobooks: data.fetch("supports_audiobooks", true),
  supports_ebooks: data.fetch("supports_ebooks", true),
  supports_comicbooks: data.fetch("supports_comicbooks", false),
  priority: data.fetch("priority", 0),
  enabled: data.fetch("enabled", true)
)
ap_.save!

puts({ ok: true, id: ap_.id, name: ap_.name, persisted: ap_.persisted? }.to_json)
