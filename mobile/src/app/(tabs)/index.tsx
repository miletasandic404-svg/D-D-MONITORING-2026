import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  RefreshControl,
  TouchableOpacity,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { DashboardStats, Incident } from '../../types';

interface StatCard {
  title: string;
  value: number | string;
  icon: string;
  color: string;
  route?: string;
}

export default function DashboardScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [statsData, incidentsData] = await Promise.all([
        api.getDashboardStats(),
        api.getIncidents('new'),
      ]);
      setStats(statsData);
      setIncidents(incidentsData.slice(0, 5));
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const onRefresh = async () => {
    setIsRefreshing(true);
    await loadData();
    setIsRefreshing(false);
  };

  const getStatCards = (): StatCard[] => {
    if (!stats) return [];
    
    return [
      {
        title: 'Ukupno kamera',
        value: stats.total_cameras,
        icon: '📹',
        color: '#208AEF',
        route: '/cameras',
      },
      {
        title: 'Online',
        value: stats.online_cameras,
        icon: '✅',
        color: '#10b981',
        route: '/cameras',
      },
      {
        title: 'Offline',
        value: stats.offline_cameras,
        icon: '❌',
        color: '#ef4444',
        route: '/cameras',
      },
      {
        title: 'Aktivni incidenti',
        value: stats.active_incidents,
        icon: '⚠️',
        color: '#f59e0b',
        route: '/incidents',
      },
    ];
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

  const formatTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    
    if (minutes < 60) return `pre ${minutes} min`;
    if (hours < 24) return `pre ${hours} h`;
    return date.toLocaleDateString('sr-RS');
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <Text style={styles.loadingText}>Učitavanje...</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={onRefresh}
          tintColor="#e94560"
        />
      }
    >
      {/* Welcome Section */}
      <View style={styles.welcomeSection}>
        <Text style={styles.welcomeText}>
          Dobrodošli, <Text style={styles.userName}>{user?.display_name || 'Admin'}</Text>
        </Text>
        <Text style={styles.dateText}>
          {new Date().toLocaleDateString('sr-RS', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
          })}
        </Text>
      </View>

      {/* Stats Grid */}
      <View style={styles.statsGrid}>
        {getStatCards().map((stat, index) => (
          <TouchableOpacity
            key={index}
            style={[styles.statCard, { borderLeftColor: stat.color }]}
            onPress={() => stat.route && router.push(stat.route)}
          >
            <Text style={styles.statIcon}>{stat.icon}</Text>
            <Text style={styles.statValue}>{stat.value}</Text>
            <Text style={styles.statTitle}>{stat.title}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Critical Alert */}
      {stats?.critical_incidents ? (
        <View style={styles.alertBanner}>
          <Text style={styles.alertIcon}>🚨</Text>
          <View style={styles.alertContent}>
            <Text style={styles.alertTitle}>Kritičan incident!</Text>
            <Text style={styles.alertText}>
              {stats.critical_incidents} kritičan/kritična incident/a zahteva pažnju
            </Text>
          </View>
          <TouchableOpacity onPress={() => router.push('/incidents')}>
            <Text style={styles.alertAction}>Vidi →</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {/* Recent Incidents */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Nedavni incidenti</Text>
          <TouchableOpacity onPress={() => router.push('/incidents')}>
            <Text style={styles.seeAll}>Vidi sve</Text>
          </TouchableOpacity>
        </View>

        {incidents.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>✅</Text>
            <Text style={styles.emptyText}>Nema novih incidenata</Text>
          </View>
        ) : (
          incidents.map((incident) => (
            <TouchableOpacity
              key={incident.id}
              style={styles.incidentCard}
              onPress={() => router.push(`/incidents/${incident.id}`)}
            >
              <View
                style={[
                  styles.priorityBadge,
                  { backgroundColor: getPriorityColor(incident.priority) },
                ]}
              >
                <Text style={styles.priorityText}>
                  {incident.priority.toUpperCase()}
                </Text>
              </View>
              <View style={styles.incidentContent}>
                <Text style={styles.incidentTitle}>{incident.title}</Text>
                <Text style={styles.incidentMeta}>
                  {incident.camera_name || 'Nepoznata kamera'} • {formatTime(incident.created_at)}
                </Text>
              </View>
              <Text style={styles.incidentArrow}>›</Text>
            </TouchableOpacity>
          ))
        )}
      </View>

      {/* Quick Actions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Brze akcije</Text>
        <View style={styles.quickActions}>
          <TouchableOpacity
            style={styles.quickAction}
            onPress={() => router.push('/cameras')}
          >
            <Text style={styles.quickActionIcon}>📹</Text>
            <Text style={styles.quickActionText}>Live kamere</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.quickAction}
            onPress={() => router.push('/incidents')}
          >
            <Text style={styles.quickActionIcon}>📋</Text>
            <Text style={styles.quickActionText}>Svi incidenti</Text>
          </TouchableOpacity>
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
    fontSize: 16,
  },
  welcomeSection: {
    padding: 20,
    paddingTop: 10,
  },
  welcomeText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  userName: {
    color: '#e94560',
  },
  dateText: {
    fontSize: 14,
    color: '#888',
    marginTop: 4,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 12,
  },
  statCard: {
    width: '46%',
    marginHorizontal: '2%',
    marginBottom: 12,
    backgroundColor: '#16213e',
    borderRadius: 16,
    padding: 16,
    borderLeftWidth: 4,
  },
  statIcon: {
    fontSize: 24,
    marginBottom: 8,
  },
  statValue: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#fff',
  },
  statTitle: {
    fontSize: 12,
    color: '#888',
    marginTop: 4,
  },
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 12,
  },
  alertIcon: {
    fontSize: 28,
    marginRight: 12,
  },
  alertContent: {
    flex: 1,
  },
  alertTitle: {
    color: '#ef4444',
    fontWeight: 'bold',
    fontSize: 14,
  },
  alertText: {
    color: '#fff',
    fontSize: 12,
  },
  alertAction: {
    color: '#e94560',
    fontWeight: 'bold',
  },
  section: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fff',
  },
  seeAll: {
    color: '#e94560',
    fontSize: 14,
  },
  emptyState: {
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 8,
  },
  emptyText: {
    color: '#888',
    fontSize: 14,
  },
  incidentCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
  },
  priorityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginRight: 12,
  },
  priorityText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  incidentContent: {
    flex: 1,
  },
  incidentTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '500',
  },
  incidentMeta: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
  },
  incidentArrow: {
    color: '#888',
    fontSize: 24,
  },
  quickActions: {
    flexDirection: 'row',
    gap: 12,
  },
  quickAction: {
    flex: 1,
    backgroundColor: '#16213e',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  quickActionIcon: {
    fontSize: 28,
    marginBottom: 8,
  },
  quickActionText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '500',
  },
  bottomPadding: {
    height: 20,
  },
});
