CREATE VIEW zoom.inspect_identity AS SELECT cluster_id FROM zoom.cluster_identity;
GRANT SELECT ON zoom.inspect_identity TO zoom_inspector;
