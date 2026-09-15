import { useEffect, useState } from 'react';
import { listGroups, reorderGroups as saveGroupOrder } from '../../api/groups';
import type { GroupSummary } from './sidebarTypes';

/** 侧栏工作群列表：10 秒轮询（标签页在后台时暂停），拖拽排序乐观更新。 */
export function useSidebarGroups() {
  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);

  // Load groups
  useEffect(() => {
    const loadGroups = async () => {
      try {
        const res = await listGroups();
        const data = await res.json();
        if (data.success) {
          setGroups(data.groups);
          setGroupsLoaded(true);
        }
      } catch {}
    };
    loadGroups();
    // 标签页在后台时不轮询；切回来时立即刷新一次。
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void loadGroups(); }, 10000);
    const handleVisible = () => { if (document.visibilityState !== 'hidden') void loadGroups(); };
    document.addEventListener('visibilitychange', handleVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisible);
    };
  }, []);

  const reloadGroups = async () => {
    try {
      const res = await listGroups();
      const data = await res.json();
      if (data.success) {
        setGroups(data.groups);
        setGroupsLoaded(true);
      }
    } catch {}
  };

  const reorderGroups = async (newGroups: GroupSummary[]) => {
    setGroups(newGroups);
    try {
      await saveGroupOrder(newGroups.map((group) => group.id));
    } catch (err) {
      console.error('Failed to save group order:', err);
      reloadGroups();
    }
  };

  return { groups, groupsLoaded, reloadGroups, reorderGroups };
}
