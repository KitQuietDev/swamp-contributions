data = JSON.parse(File.read(ENV.fetch("SHIM_DATA_PATH")))

dc = DownloadClient.find_or_initialize_by(name: data.fetch("name"))
dc.assign_attributes(
  client_type: data.fetch("client_type"),
  url: data.fetch("url"),
  api_key: data["api_key"],
  username: data["username"],
  password: data["password"],
  download_path: data["download_path"],
  category: data["category"],
  priority: data.fetch("priority", 0),
  enabled: data.fetch("enabled", true)
)
dc.save!

puts({ ok: true, id: dc.id, name: dc.name, persisted: dc.persisted? }.to_json)
