import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import api from '../../services/api';
import { Camera } from '../../types';

export default function CamerasScreen() {
  const router = useRouter();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [filteredCameras, setFilteredCameras] = useState<Camera[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'online' | 'offline'>('all');

  useEffect(() => {
    loadCameras();
  }, []);

  useEffect(() => {
    filterCameras();
  }, [cameras, searchQuery, filter]);

  const loadCameras = async () => {
    try {
      const data = await api.getCameras();
      setCameras(data);
    } catch (error) {
      console.error('Failed to load cameras:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const filterCameras = () => {
    let result = cameras;

    // Apply status filter
    if (filter === 'online') {
      result = result.filter((c) => c.status === 'online' || c.status === 'recording');
    } else if (filter === 'offline') {
      result = result.filter((c) => c.status === 'offline');
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (c) =>
          c.name.toLowerCase().includes(query) ||
          c.location?.toLowerCase().includes(query)
      );
    }

    setFilteredCameras(result);
  };

  const onRefresh = async () => {
    setIsRefreshing(true);
    await loadCameras();
    setIsRefreshing(false);
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

  const getStatusText = (status: string) => {
    switch (status) {
      case 'online':
        return 'Online';
      case 'recording':
        return 'Snima';
      case 'offline':
        return 'Offline';
      default:
        return status;
    }
  };

  const renderCameraItem = ({ item }: { item: Camera }) => (
    <TouchableOpacity
      style={styles.cameraCard}
      onPress={() => router.push(`/cameras/${item.id}`)}
    >
      <View style={styles.thumbnailContainer}>
        <View style={styles.thumbnail}>
          <Text style={styles.thumbnailIcon}>📹</Text>
        </View>
        <View
          style={[styles.statusIndicator, { backgroundColor: getStatusColor(item.status) }]}
        />
      </View>
      <View style={styles.cameraInfo}>
        <Text style={styles.cameraName}>{item.name}</Text>
        <Text style={styles.cameraLocation}>{item.location || 'Nepoznata lokacija'}</Text>
        <View style={styles.cameraMeta}>
          <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.status) }]}>
            <Text style={styles.statusText}>{getStatusText(item.status)}</Text>
          </View>
          <Text style={styles.cameraId}>ID: {item.id.slice(0, 8)}</Text>
        </View>
      </View>
      <Text style={styles.arrow}>›</Text>
    </TouchableOpacity>
  );

  const renderFilters = () => (
    <View style={styles.filterContainer}>
      <TouchableOpacity
        style={[styles.filterButton, filter === 'all' && styles.filterButtonActive]}
        onPress={() => setFilter('all')}
      >
        <Text style={[styles.filterText, filter === 'all' && styles.filterTextActive]}>
          Sve ({cameras.length})
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.filterButton, filter === 'online' && styles.filterButtonActive]}
        onPress={() => setFilter('online')}
      >
        <Text style={[styles.filterText, filter === 'online' && styles.filterTextActive]}>
          ✅ Online ({cameras.filter((c) => c.status === 'online' || c.status === 'recording').length})
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.filterButton, filter === 'offline' && styles.filterButtonActive]}
        onPress={() => setFilter('offline')}
      >
        <Text style={[styles.filterText, filter === 'offline' && styles.filterTextActive]}>
          ❌ Offline ({cameras.filter((c) => c.status === 'offline').length})
        </Text>
      </TouchableOpacity>
    </View>
  );

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Učitavanje kamera...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput}
          placeholder="Pretraži kamere..."
          placeholderTextColor="#888"
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
      </View>

      {/* Filter Buttons */}
      {renderFilters()}

      {/* Camera List */}
      <FlatList
        data={filteredCameras}
        renderItem={renderCameraItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={onRefresh}
            tintColor="#e94560"
          />
        }
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>📹</Text>
            <Text style={styles.emptyTitle}>Nema kamera</Text>
            <Text style={styles.emptyText}>
              {searchQuery
                ? 'Nema kamera koje odgovaraju pretrazi'
                : 'Dodajte prvu kameru u sistem'}
            </Text>
          </View>
        }
      />
    </View>
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
    fontSize: 16,
  },
  searchContainer: {
    padding: 16,
    paddingBottom: 8,
  },
  searchInput: {
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    color: '#fff',
    borderWidth: 1,
    borderColor: '#333',
  },
  filterContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  filterButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#16213e',
  },
  filterButtonActive: {
    backgroundColor: '#e94560',
  },
  filterText: {
    color: '#888',
    fontSize: 12,
  },
  filterTextActive: {
    color: '#fff',
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 20,
  },
  cameraCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  thumbnailContainer: {
    position: 'relative',
    marginRight: 12,
  },
  thumbnail: {
    width: 64,
    height: 48,
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  thumbnailIcon: {
    fontSize: 24,
  },
  statusIndicator: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#16213e',
  },
  cameraInfo: {
    flex: 1,
  },
  cameraName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  cameraLocation: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
  },
  cameraMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 8,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  statusText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  cameraId: {
    color: '#666',
    fontSize: 10,
  },
  arrow: {
    color: '#888',
    fontSize: 24,
    marginLeft: 8,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 60,
  },
  emptyIcon: {
    fontSize: 60,
    marginBottom: 16,
  },
  emptyTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  emptyText: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
  },
});
