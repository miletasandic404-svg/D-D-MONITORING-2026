-- D&D Global AI Surveillance Platform - Database Schema
-- Supports YOLO object detection attribute filtering

-- Cameras table
CREATE TABLE cameras (
    id VARCHAR(20) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    rtsp_url VARCHAR(255),
    location VARCHAR(100),
    lat DOUBLE PRECISION,
    lng DOUBLE PRECISION,
    enabled BOOLEAN DEFAULT TRUE,
    resolution VARCHAR(20),
    fps INTEGER,
    codec VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Events table with AI detection attributes
CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    camera_id VARCHAR(20) NOT NULL REFERENCES cameras(id),
    event_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) DEFAULT 'INFO',
    description TEXT,
    is_dismissed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- AI Detection Results table
CREATE TABLE ai_detections (
    id SERIAL PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    object_type VARCHAR(50) NOT NULL,
    confidence FLOAT NOT NULL,
    bounding_box JSONB,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Object Attributes table for filtering
CREATE TABLE object_attributes (
    id SERIAL PRIMARY KEY,
    detection_id INTEGER NOT NULL REFERENCES ai_detections(id) ON DELETE CASCADE,
    attribute_type VARCHAR(50) NOT NULL,
    attribute_value VARCHAR(100) NOT NULL,
    confidence FLOAT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for efficient filtering
CREATE INDEX idx_events_timestamp ON events(timestamp DESC);
CREATE INDEX idx_events_camera_id ON events(camera_id);
CREATE INDEX idx_events_event_type ON events(event_type);
CREATE INDEX idx_ai_detections_object_type ON ai_detections(object_type);
CREATE INDEX idx_ai_detections_event_id ON ai_detections(event_id);
CREATE INDEX idx_object_attributes_type ON object_attributes(attribute_type);
CREATE INDEX idx_object_attributes_value ON object_attributes(attribute_value);
CREATE INDEX idx_object_attributes_detection_id ON object_attributes(detection_id);
CREATE INDEX idx_attributes_composite ON object_attributes(attribute_type, attribute_value);
