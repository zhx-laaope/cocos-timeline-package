# UI Timeline 可视化编辑器使用指南

## 概述

UI Timeline 可视化编辑器是一个功能完整的时间轴编辑工具，用于创建和编辑 UI 动画配置文件。

## 启动编辑器

在 Cocos Creator 菜单栏中选择：
```
Timeline -> UI Timeline 编辑器
```

## 界面布局

### 顶部工具栏
- **保存**：保存当前 Prefab 绑定的 Timeline
- **安装运行时**：将 `TimelinePlayer.ts` 和 `TimelineComponent.ts` 安装到当前项目
- **绑定组件**：在当前 Prefab 根节点挂载或更新 `TimelineComponent`，并绑定当前 Timeline JSON
- **撤销/重做**：撤销或重做 Timeline 编辑操作

> 当前版本按 Prefab 自动绑定 Timeline：打开 Prefab 后会优先读取 Prefab 上 TimelineComponent 的 `timelineAsset`，否则读取 `assets/Script/Timeline/configs/<PrefabName>.json`。手动新建、打开、另存为入口已禁用，避免编辑到错误文件。

### 左侧面板 - Timeline 属性
- **名称**：Timeline 的名称
- **总时长**：动画总时长（秒）
- **帧率**：播放帧率
- **循环模式**：不循环 / 循环 / 来回播放
- **自动播放**：是否自动播放

### 中间区域 - 时间轴
- **播放控制栏**：
  - ▶ 播放/暂停
  - ■ 停止
  - ⏮ 跳到开始
  - ⏭ 跳到结束
  - 时间显示
  - 缩放控制（+/-）

- **时间刻度尺**：显示时间刻度，点击可跳转

- **轨道区域**：
  - 左侧显示轨道名称、类型、目标节点
  - 右侧显示片段（彩色矩形块）
  - 红色播放头指示当前时间

### 右侧面板
- **轨道列表**：显示所有轨道，点击选中
- **添加片段**：5 种片段类型按钮
  - 🎬 Animation
  - 🦴 Spine
  - 📈 Tween
  - 💻 Code
  - 🔊 Audio

## 基本操作

### 1. 安装运行时

1. 点击顶部 **安装运行时**
2. 插件会安装或更新：
   - `assets/Script/Timeline/TimelinePlayer.ts`
   - `assets/Script/Timeline/TimelineComponent.ts`
3. 等待 Cocos Creator 编译完成
4. 编译完成后 `TimelineComponent.ts.meta` 会生成，之后才能自动绑定组件

### 2. 创建或绑定 Timeline

1. 打开要编辑的 Prefab
2. 如果未找到同名 JSON，点击遮罩里的 **快速创建配套 Timeline**
3. Timeline 默认保存到 `assets/Script/Timeline/configs/<PrefabName>.json`
4. 点击顶部 **绑定组件**，插件会在 Prefab 根节点挂载或更新 `TimelineComponent`，并将当前 JSON 赋给 `timelineAsset`
5. 如需运行时自动播放，在左侧 Timeline 属性勾选 **自动播放** 后保存并重新点击 **绑定组件**

### 3. 添加轨道

1. 点击右侧面板的 **+** 按钮或中间的 **添加轨道** 按钮
2. 选择默认片段类型（Animation、Spine、Tween 等）
3. 输入轨道名称
4. 输入目标节点路径（相对路径，如 `child_node` 或 `.`）
5. 点击 **添加**

### 4. 添加片段

1. 在轨道列表中选中一个轨道（点击轨道）
2. 点击右侧面板的片段类型按钮
3. 片段会添加到当前播放头位置
4. 同一轨道可以放不同类型片段，轨道只负责绑定目标节点
5. 在左侧面板编辑片段属性

### 5. 编辑片段

#### 移动片段
- 点击并拖拽片段到新位置

#### 调整时长
- 拖拽片段左右两侧的手柄
- Animation、Spine、Audio 片段时长由资源决定，不能拖拽改时长

#### 编辑属性
1. 点击选中片段
2. 在左侧面板 **选中片段属性** 区域编辑：
   - 片段名称
   - 开始时间
   - 持续时间（Code 可编辑；Tween、Animation、Spine、Audio 会自动计算）
   - 其他特定属性

### 6. 预览播放

1. 点击 **▶** 播放按钮
2. 播放头会推进，并在当前 Prefab 编辑态临时应用 Tween、Animation、Spine、Code 片段
3. 点击 **⏸** 暂停
4. 点击 **■** 停止并重置到开始，同时恢复预览前的节点状态

> Audio 片段可编辑并可在运行时播放；编辑器内音频预览暂未启用。

### 7. 时间轴导航

- **缩放**：使用 +/- 按钮调整时间轴缩放（25% - 400%）
- **跳转/拖动**：点击或拖动时间刻度尺跳转到指定时间
- **滚动**：使用鼠标滚轮或滚动条浏览
- **逐帧微调**：方向键移动播放头；选中片段时方向键移动片段，Shift 加速

### 8. 保存文件

1. 点击 **保存** 按钮
2. 保存当前 Prefab 绑定的 Timeline JSON
3. 保存后 Cocos Creator 会刷新对应资源

## 轨道和片段类型说明

轨道绑定一个目标节点路径，并提供一个默认片段类型；真正执行什么行为由片段的 `type` 决定。因此一个节点需要同时做 Tween 和 Spine 时，可以放在同一条目标节点轨道里，也可以按组织习惯拆成多条轨道。

### Animation 片段
控制 cc.Animation 组件播放。

**片段属性**：
- `clipName`: Animation 剪辑名称
- `speed`: 播放速度
- `loop`: 是否循环
- `duration`: 从 `cc.AnimationClip.duration` 自动同步，不在工具内手动编辑

### Spine 片段
控制 sp.Skeleton 组件播放。

**片段属性**：
- `animName`: Spine 动画名称
- `speed`: 播放速度
- `loop`: 是否循环
- `trackIndex`: 轨道索引
- `duration`: 从 Spine 动画时长自动同步，不在工具内手动编辑

### Tween 片段
创建补间动画。

**片段属性**：
- `actions`: 对齐 `cc.tween` 链式动作的数据列表，右侧面板提供结构化编辑；支持 `to`、`by`、`set`、`delay`、`call`、`sequence`、`then`、`parallel`、`spawn`、`repeat`、`repeatForever`、`reverseTime`、`show`、`hide`、`flipX`、`flipY`、`blink`、`bezierTo`、`bezierBy`、`removeSelf`
- `duration`: 从 `actions` 自动计算；修改 `actions` 后会同步到片段长度
- 旧格式 `props`、`from`、`easing` 会在加载/保存时迁移并移除，新片段只使用 `actions`
- `removeSelf` 在 Timeline 预览和运行时中按 `active = false` 处理，避免采样时破坏节点层级

**actions 示例**：
```json
[
  { "type": "to", "duration": 0.45, "props": { "x": 0, "y": 100, "opacity": 255 }, "easing": "sineOut" },
  { "type": "parallel", "actions": [
    { "type": "by", "duration": 0.3, "props": { "scale": 0.2 } },
    { "type": "set", "props": { "active": true } }
  ] }
]
```

### Code 片段
触发代码回调。

**片段属性**：
- `callbackName`: 回调函数名称
- `params`: 回调参数数组

### Audio 片段
播放音频。

**片段属性**：
- `audioUrl`: 音频资源路径
- `volume`: 音量（0-1）
- `loop`: 是否循环
- `duration`: 从 `cc.AudioClip.duration` 自动同步，不在工具内手动编辑

### Active 兼容
Active 不再作为新增片段类型提供。历史 Timeline 中的 `type: "active"` 会继续兼容运行；新数据请使用 Tween actions 的 `set`、`show` 或 `hide`。

## 片段颜色说明

- 🔵 **蓝色** - Animation
- 🟣 **紫色** - Spine
- 🟢 **绿色** - Tween
- 🟠 **橙色** - Code
- 🔴 **红色** - Audio

## 快捷操作

### 选择
- **点击轨道头部**：选中轨道
- **点击片段**：选中片段
- **点击时间尺**：跳转时间

### 编辑
- **拖拽片段**：移动片段位置
- **拖拽手柄**：调整 Code 片段时长；Tween 从 actions 自动计算
- **双击片段**：快速编辑（未来功能）

### 视图
- **+/-**：缩放时间轴
- **滚动**：浏览时间轴
- **播放头**：指示当前时间

## 工作流程示例

### 创建卡包开启动画

1. **新建 Timeline**
   - 名称：`card_open_105`
   - 时长：8.0 秒

2. **添加节点轨道**
   - 名称：卡包动画
   - 默认片段类型：Spine
   - 目标：`spine_pack`

3. **添加开包片段**
   - 类型：Spine
   - 开始：0s
   - 时长：由 `open_105` 动画自动同步
   - animName：`open_105`

4. **添加待机片段**
   - 类型：Spine
   - 开始：2.64s
   - 时长：由 `idle_105` 动画自动同步
   - animName：`idle_105`

5. **在同一节点需要混合行为时直接添加不同片段**
   - 同一轨道绑定一个目标节点，片段类型决定行为
   - 例如 `spine_pack` 轨道可以同时放 Spine 和 Tween 片段，节点显隐使用 Tween 的 `actions` 中的 `set/show/hide`

6. **添加 Tween 轨道**
   - 名称：卡牌飞入
   - 默认片段类型：Tween
   - 目标：`card_layer/card_1`

7. **添加飞入片段**
   - 开始：2.64s
   - 时长：由 `actions` 自动计算
   - actions：`[{ "type": "to", "duration": 0.45, "props": { "x": 0, "y": 100, "opacity": 255 }, "easing": "sineOut" }]`

8. **预览播放**
   - 点击播放按钮查看效果
   - 调整时间和参数

9. **保存**
   - 保存到 `Timeline/configs/card_open_105.json`

## 注意事项

1. **目标节点路径**
   - 使用相对路径，相对于挂载 TimelineComponent 的节点
   - `.` 表示当前节点
   - `child_node` 表示子节点
   - `../sibling` 表示兄弟节点

2. **时间精度**
   - 支持小数（如 2.64）
   - 建议使用 0.1 秒的倍数

3. **片段重叠**
	- 同一轨道的片段可以重叠
	- 重叠部分的行为取决于片段类型和轨道顺序

4. **保存位置**
   - 默认保存到 `assets/Script/Timeline/configs/`
   - 运行时推荐通过 `TimelineComponent.timelineAsset` 直接引用 JSON

5. **文件格式**
   - 保存为标准 JSON 格式
   - 可以手动编辑 JSON 文件
   - 编辑器会自动格式化

## 常见问题

### Q: 编辑器打不开？
A: 检查 Cocos Creator 版本是否为 2.4.x，重启编辑器。

### Q: 保存的文件在哪里？
A: 默认保存在 `assets/Script/Timeline/configs/` 目录。

### Q: 如何删除轨道或片段？
A: 当前版本需要手动编辑 JSON 文件删除，未来版本会添加删除按钮。

### Q: 片段拖不动？
A: 确保点击的是片段本身，而不是调整手柄。

### Q: 如何复制片段？
A: 当前版本需要手动复制 JSON，未来版本会添加复制功能。

## 未来功能

- [ ] 删除轨道和片段
- [ ] 复制/粘贴片段
- [ ] 多选和批量操作
- [ ] 撤销/重做
- [ ] 关键帧编辑
- [ ] 曲线编辑器
- [ ] 实时预览（在场景中）
- [ ] 导入/导出模板

## 技术支持

如有问题，请查看：
- `README.md` - 完整文档
- `QUICKSTART.md` - 快速开始
- `IMPLEMENTATION_SUMMARY.md` - 实现细节
