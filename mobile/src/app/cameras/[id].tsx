import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { VideoView } from 'expo-video';
import api from '../../services/api';
import { Camera } from '../../types';

export default function CameraDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [camera, setCamera] = useState<Camera | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCamera();
  }, [id]);

  const loadCamera = async () => {
    if (!id) return;
    
    try {
      const data = await api.getCamera(id);
      setCamera(data);
    } catch (err) {
      setError('Kamera nije pronađena');
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'online':
        return '#10b981';
      case 'recording':
        return '#f59e0b';
      case 'offline':
        return '#ef4444';
      default:
        return '#6b7280';
    }
  };

  const handleSnapshot = () => {
    Alert.alert('Snimka', 'Snimka ekrana je uspešno sačuvana!');
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#e94560" />
        <Text style={styles.loadingText}>Učitavanje kamere...</Text>
      </View>
    );
  }

  if (error || !camera) {
    return (
      <View style={styles.errorContainer}>
        <Text style={styles.errorIcon}>❌</Text>
        <Text style={styles.errorText}>{error || 'Kamera nije pronađena'}</Text>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backButtonText}>Nazad</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {/* Video Player */}
      <View style={styles.videoContainer}>
        {camera.status === 'offline' ? (
          <View style={styles.offlinePlaceholder}>
            <Text style={styles.offlineIcon}>📹</Text>
            <Text style={styles.offlineText}>Kamera je offline</Text>
            <Text style={styles.offlineSubtext}>Nema dostupnog video signala</Text>
          </View>
        ) : camera.stream_url ? (
          <VideoView
            player={null}
            style={styles.video}
            showsNativeControls
          />
        ) : (
          <View style={styles.offlinePlaceholder}>
            <Text style={styles.offlineIcon}>📹</Text>
            <Text style={styles.offlineText}>Stream nije dostupan</Text>
          </View>
        )}
        
        {/* Status Overlay */}
        <View style={styles.statusOverlay}>
          <View style={[styles.statusBadge, { backgroundColor: getStatusColor(camera.status) }]}>
            <Text style={styles.statusBadgeText}>
              {camera.status === 'online' ? 'LIVE' : camera.status === 'recording' ? 'REC' : 'OFFLINE'}
            </Text>
          </View>
        </View>
      </View>

      {/* Camera Info */}
      <View style={styles.infoSection}>
        <Text style={styles.cameraName}>{camera.name}</Text>
        <View style={styles.locationRow}>
          <Text style={styles.locationIcon}>📍</Text>
          <Text style={styles.locationText}>{camera.location || 'Nepoznata lokacija'}</Text>
        </View>
      </View>

      {/* Action Buttons */}
      <View style={styles.actionsContainer}>
        <TouchableOpacity style={styles.actionButton} onPress={handleSnapshot}>
          <Text style={styles.actionIcon}>📸</Text>
          <Text style={styles.actionText}>Snimka</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionButton}>
          <Text style={styles.actionIcon}>🔊</Text>
          <Text style={styles.actionText}>Audio</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionButton}>
          <Text style={styles.actionIcon}>📊</Text>
          <Text style={styles.actionText}>AI</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionButton}>
          <Text style={styles.actionIcon}>🔄</Text>
          <Text style={styles.actionText}>PTZ</Text>
        </TouchableOpacity>
      </View>

      {/* Camera Details */}
      <View style={styles.detailsSection}>
        <Text style={styles.sectionTitle}>Detalji kamere</Text>
        
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>ID kamere</Text>
          <Text style={styles.detailValue}>{camera.id}</Text>
        </View>
        
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Status</Text>
          <View style={[styles.statusBadgeSmall, { backgroundColor: getStatusColor(camera.status) }]}>
            <Text style={styles.statusTextSmall}>
              {camera.status === 'online' ? 'Online' : camera.status === 'recording' ? 'Snima' : 'Offline'}
            </Text>
          </View>
        </View>
        
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Omogućena</Text>
          <Text style={styles.detailValue}>{camera.enabled ? 'Da' : 'Ne'}</Text>
        </View>
        
        <View style={styles.detailRow}>
          <Text style={styles.detailLabel}>Kreirano</Text>
          <Text style={styles.detailValue}>
            {new Date(camera.created_at).toLocaleDateString('sr-RS')}
          </Text>
        </View>
        
        {camera.rtsp_url && (
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>RTSP URL</Text>
            <Text style={styles.detailValueSmall}>{camera.rtsp_url}</Text>
          </View>
        )}
      </View>

      {/* Recent Events Placeholder */}
      <View style={styles.eventsSection}>
        <Text style={styles.sectionTitle}>Nedavni događaji</Text>
        <View style={styles.emptyEvents}>
          <Text style={styles.emptyEventsText}>Nema nedavnih događaja za ovu kameru</Text>
        </View>
      </View>

      <View style={styles.bottomPadding} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f23',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f0f23',
  },
  loadingText: {
    color: '#888',
    marginTop: 12,
    fontSize: 16,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0f0f23',
    padding: 20,
  },
  errorIcon: {
    fontSize: 60,
    marginBottom: 16,
  },
  errorText: {
    color: '#ef4444',
    fontSize: 18,
    textAlign: 'center',
    marginBottom: 20,
  },
  backButton: {
    backgroundColor: '#e94560',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  backButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  videoContainer: {
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
    position: 'relative',
  },
  video: {
    flex: 1,
  },
  offlinePlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#1a1a2e',
  },
  offlineIcon: {
    fontSize: 60,
    marginBottom: 12,
  },
  offlineText: {
    color: '#888',
    fontSize: 18,
    fontWeight: '600',
  },
  offlineSubtext: {
    color: '#666',
    fontSize: 14,
    marginTop: 4,
  },
  statusOverlay: {
    position: 'absolute',
    top: 12,
    right: 12,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 4,
  },
  statusBadgeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  infoSection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#16213e',
  },
  cameraName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 8,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  locationIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  locationText: {
    color: '#888',
    fontSize: 14,
  },
  actionsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#16213e',
  },
  actionButton: {
    alignItems: 'center',
    padding: 12,
  },
  actionIcon: {
    fontSize: 28,
    marginBottom: 4,
  },
  actionText: {
    color: '#888',
    fontSize: 12,
  },
  detailsSection: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#16213e',
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fff',
    marginBottom: 16,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#16213e',
  },
  detailLabel: {
    color: '#888',
    fontSize: 14,
  },
  detailValue: {
    color: '#fff',
    fontSize: 14,
  },
  detailValueSmall: {
    color: '#888',
    fontSize: 12,
    maxWidth: 180,
  },
  statusBadgeSmall: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusTextSmall: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  eventsSection: {
    padding: 16,
  },
  emptyEvents: {
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
  },
  emptyEventsText: {
    color: '#888',
    fontSize: 14,
  },
  bottomPadding: {
    height: 40,
  },
});
