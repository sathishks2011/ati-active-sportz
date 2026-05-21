# Adds Splicer.swift + SplicerBridge.mm to the ActiveSportz Xcode target.
# Idempotent — safe to re-run; skips files that are already present.
#
# Run from app/:
#   bundle exec ruby scripts/add_splicer_to_xcode.rb

require 'xcodeproj'

PROJECT_PATH = 'ios/ActiveSportz.xcodeproj'
TARGET_NAME = 'ActiveSportz'
GROUP_NAME = 'ActiveSportz'
FILES = ['Splicer.swift', 'SplicerBridge.mm'].freeze

project = Xcodeproj::Project.open(PROJECT_PATH)
target = project.targets.find { |t| t.name == TARGET_NAME } or
  abort("Target #{TARGET_NAME} not found")
group = project.main_group[GROUP_NAME] or
  abort("Group #{GROUP_NAME} not found at project root")

added = []
skipped = []

FILES.each do |filename|
  existing = group.files.find { |f| f.path&.end_with?(filename) }
  if existing
    skipped << filename
    next
  end
  file_ref = group.new_file("ActiveSportz/#{filename}")
  target.source_build_phase.add_file_reference(file_ref)
  added << filename
end

project.save

puts "added:   #{added.join(', ')}" unless added.empty?
puts "skipped: #{skipped.join(', ')}" unless skipped.empty?
puts 'done.'
