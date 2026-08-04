import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import api from '../../services/api';
import { Incident } from '../../types';

export default function IncidentsScreen() {
  const router = useRouter();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'new' | 'active' | 'resolved'>('all');

  useEffect(() => {
    loadIncidents();
  }, []);

  const loadIncidents = async () => {
    try {
      const data = await api.getIncidents();
      setIncidents(data);
    } catch (error) {
      console.error('Failed to load incidents:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const onRefresh = async () => {
    setIsRefreshing(true);
    await loadIncidents();
    setIsRefreshing(false);
  };

  const getFilteredIncidents = () => {
    switch (filter) {
      case 'new':
        return incidents.filter((i) => i.status === 'new');
      case 'active':
        return incidents.filter((i) => ['acknowledged', 'in_progress'].includes(i.status));
      case 'resolved':
        return incidents.filter((i) => ['resolved', 'false_alarm'].includes(i.status));
      default:
        return incidents;
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'critical':
        return '#ef4444';
      case 'high':
        return '#f59e0b';
      case 'medium':
        return '#3b82f6';
      case 'low':
        return '#6b7280';
      default:
        return '#6b7280';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'new':
        return '#ef4444';
      case 'acknowledged':
        return '#f59e0b';
      case 'in_progress':
        return '#3b82f6';
      case 'resolved':
        return '#10b981';
      case 'false_alarm':
        return '#6b7280';
      default:
        return '#6b7280';
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'new':
        return 'Novi';
      case 'acknowledged':
        return 'Primljen';
      case 'in_progress':
        return 'U toku';
      case 'resolved':
        return 'Rešen';
      case 'false_alarm':
        return 'Lažna uzbuna';
      default:
        return status;
    }
  };

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 60) return `pre ${minutes} min`;
    if (hours < 24) return `pre ${hours} h`;
    if (days < 7) return `pre ${days} dana`;
    return date.toLocaleDateString('sr-RS');
  };

  const handleResolve = async (id: string) => {
    try {
      await api.updateIncidentStatus(id, 'resolved');
      loadIncidents();
    } catch (error) {
      console.error('Failed to resolve incident:', error);
    }
  };

  const handleAcknowledge = async (id: string) => {
    try {
      await api.updateIncidentStatus(id, 'acknowledged');
      loadIncidents();
    } catch (error) {
      console.error('Failed to acknowledge incident:', error);
    }
  };

  const renderIncidentItem = ({ item }: { item: Incident }) => (
    <View style={styles.incidentCard}>
      <View style={styles.incidentHeader}>
        <View
          style={[styles.priorityBadge, { backgroundColor: getPriorityColor(item.priority) }]}
        >
          <Text style={styles.priorityText}>{item.priority.toUpperCase()}</Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(item.status) }]}>
          <Text style={styles.statusText}>{getStatusText(item.status)}</Text>
        </View>
      </View>

      <Text style={styles.incidentTitle}>{item.title}</Text>
      <Text style={styles.incidentDescription} numberOfLines={2}>
        {item.description}
      </Text>

      <View style={styles.incidentMeta}>
        <View style={styles.metaRow}>
          <Text style={styles.metaIcon}>📹</Text>
          <Text style={styles.metaText}>{item.camera_name || 'Nepoznata kamera'}</Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaIcon}>🕐</Text>
          <Text style={styles.metaText}>{formatTime(item.created_at)}</Text>
        </View>
      </View>

      {item.status === 'new' && (
        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.acknowledgeBtn]}
            onPress={() => handleAcknowledge(item.id)}
          >
            <Text style={styles.actionBtnText}>Primi</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, styles.resolveBtn]}
            onPress={() => handleResolve(item.id)}
          >
            <Text style={styles.actionBtnText}>Reši</Text>
          </TouchableOpacity>
        </View>
      )}

      {item.status === 'acknowledged' && (
        <View style={styles.actionButtons}>
          <TouchableOpacity
            style={[styles.actionBtn, styles.resolveBtn]}
            onPress={() => handleResolve(item.id)}
          >
            <Text style={styles.actionBtnText}>Označi kao rešeno</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );

  const renderFilters = () => {
    const filters = [
      { key: 'all', label: 'Svi', count: incidents.length },
      { key: 'new', label: 'Novi', count: incidents.filter((i) => i.status === 'new').length },
      { key: 'active', label: 'Aktivni', count: incidents.filter((i) => ['acknowledged', 'in_progress'].includes(i.status)).length },
      { key: 'resolved', label: 'Rešeni', count: incidents.filter((i) => ['resolved', 'false_alarm'].includes(i.status)).length },
    ];

    return (
      <View style={styles.filterContainer}>
        {filters.map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[styles.filterButton, filter === f.key && styles.filterButtonActive]}
            onPress={() => setFilter(f.key as any)}
          >
            <Text style={[styles.filterText, filter === f.key && styles.filterTextActive]}>
              {f.label} ({f.count})
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Učitavanje incidenata...</Text>
      </View>
    );
  }

  const filteredIncidents = getFilteredIncidents();

  return (
    <View style={styles.container}>
      {renderFilters()}

      <FlatList
        data={filteredIncidents}
        renderItem={renderIncidentItem}
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
            <Text style={styles.emptyIcon}>✅</Text>
            <Text style={styles.emptyTitle}>Nema incidenata</Text>
            <Text style={styles.emptyText}>
              {filter === 'all'
                ? 'Sistem ne detektuje probleme'
                : `Nema incidenata u kategoriji "${filter}"`}
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
  filterContainer: {
    flexDirection: 'row',
    padding: 16,
    paddingBottom: 8,
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
  incidentCard: {
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  incidentHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  priorityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  priorityText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  statusText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  incidentTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 6,
  },
  incidentDescription: {
    color: '#888',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  incidentMeta: {
    flexDirection: 'row',
    gap: 16,
    marginBottom: 12,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  metaIcon: {
    fontSize: 12,
    marginRight: 4,
  },
  metaText: {
    color: '#666',
    fontSize: 12,
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  acknowledgeBtn: {
    backgroundColor: '#f59e0b',
  },
  resolveBtn: {
    backgroundColor: '#10b981',
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
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
