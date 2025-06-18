// ==UserScript==
// @name         ucloud-Evolved-Plus
// @namespace    http://tampermonkey.net/
// @version      0.33
// @description  主页作业显示所属课程，统一展示本学期所有课程，使用Office 365预览课件，增加通知显示数量，通知按时间排序，去除悬浮窗，解除复制限制，课件自动下载，批量下载，资源页展示全部下载按钮，更好的页面标题
// @author       Quarix, Xyea
// @match        https://ucloud.bupt.edu.cn/*
// @match        https://ucloud.bupt.edu.cn/uclass/course.html*
// @match        https://ucloud.bupt.edu.cn/uclass/*
// @match        https://ucloud.bupt.edu.cn/office/*
// @icon         https://ucloud.bupt.edu.cn/favicon.ico
// @require      https://lf9-cdn-tos.bytecdntp.com/cdn/expire-1-M/nprogress/0.2.0/nprogress.min.js#sha256-XWzSUJ+FIQ38dqC06/48sNRwU1Qh3/afjmJ080SneA8=
// @resource     NPROGRESS_CSS https://lf3-cdn-tos.bytecdntp.com/cdn/expire-1-M/nprogress/0.2.0/nprogress.min.css#sha256-pMhcV6/TBDtqH9E9PWKgS+P32PVguLG8IipkPyqMtfY=
// @connect      github.com
// @grant        GM_getResourceText
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @run-at       document-start
// @license      MIT
// @downloadURL https://update.greasyfork.org/scripts/532489/ucloud-Evolved.user.js
// @updateURL https://update.greasyfork.org/scripts/532489/ucloud-Evolved.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // ===== 常量定义 =====
    const CONSTANTS = {
        API_BASE: 'https://apiucloud.bupt.edu.cn',
        OFFICE_PREVIEW_BASE: 'https://view.officeapps.live.com/op/view.aspx?src=',

        POLLING_INTERVAL: 500, // 轮询间隔
        RETRY_ATTEMPTS: 5,
        BATCH_SIZE_LIMIT: 5,
        
        SELECTORS: {
            homeworkItems: '.in-progress-item',
            notificationContainer: '#layout-container > div.main-content > div.router-container > div > div > div.setNotice-body > ul',
            resourceItems: '//div[@class="resource-item"]/div[@class="right"]',
            previewItems: '//div[@class="resource-item"]/div[@class="left"]'
        },
        
        URLS: {
            home: 'https://ucloud.bupt.edu.cn/uclass/#/student/homePage',
            homeFallback: 'https://ucloud.bupt.edu.cn/uclass/index.html#/student/homePage',
            courseHome: 'https://ucloud.bupt.edu.cn/uclass/course.html#/student/courseHomePage',
            assignmentDetails: 'https://ucloud.bupt.edu.cn/uclass/course.html#/student/assignmentDetails_fullpage',
            resourceLearn: 'https://ucloud.bupt.edu.cn/uclass/course.html#/resourceLearn',
            notification: 'https://ucloud.bupt.edu.cn/uclass/index.html#/set/notice_fullpage',
            office: 'https://ucloud.bupt.edu.cn/office/'
        },
        
        FILE_EXTENSIONS: {
            office: ['.xls', '.xlsx', '.doc', '.docx', '.ppt', '.pptx'],
            pdf: ['.pdf'],
            image: ['.jpg', '.png', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg']
        }
    };

    // ===== 工具类 =====
    class Utils {
        static sleep(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        static async wait(func, timeout = 10000) {
            const startTime = Date.now();
            while (Date.now() - startTime < timeout) {
                const result = func();
                if (result instanceof Promise ? await result : result) {
                    return result;
                }
                await this.sleep(50);
            }
            throw new Error('Wait timeout');
        }

        static $x(xpath, context = document) {
            const iterator = document.evaluate(xpath, context, null, XPathResult.ANY_TYPE, null);
            const results = [];
            let item;
            while ((item = iterator.iterateNext())) {
                results.push(item);
            }
            return results;
        }

        static debounce(func, wait) {
            let timeout;
            return function executedFunction(...args) {
                const later = () => {
                    clearTimeout(timeout);
                    func(...args);
                };
                clearTimeout(timeout);
                timeout = setTimeout(later, wait);
            };
        }

        static throttle(func, limit) {
            let inThrottle;
            return function() {
                const args = arguments;
                const context = this;
                if (!inThrottle) {
                    func.apply(context, args);
                    inThrottle = true;
                    setTimeout(() => inThrottle = false, limit);
                }
            }
        }

        static openTab(url, options = {}) {
            const defaultOptions = {
                active: true,
                insert: true,
                setParent: true
            };
            const finalOptions = { ...defaultOptions, ...options };
            
            if (typeof GM_openInTab === 'function') {
                try {
                    return GM_openInTab(url, finalOptions);
                } catch (error) {
                    console.warn('GM_openInTab failed, fallback to window.open:', error);
                }
            }
            return window.open(url, '_blank');
        }

        static extractFilename(url) {
            try {
                const urlObj = new URL(url);
                const pathParts = urlObj.pathname.split('/');
                return decodeURIComponent(pathParts[pathParts.length - 1]) || 'unknown';
            } catch (e) {
                return 'unknown';
            }
        }

        static hasFileExtension(filename, extensions) {
            const lower = filename.toLowerCase();
            return extensions.some(ext => lower.endsWith(ext));
        }
    }

    // ===== 存储管理类 =====
    class Storage {
        static get(key) {
            try {
                const data = JSON.parse(localStorage.getItem('zzxw') || '{}');
                return data[key];
            } catch (e) {
                console.error('Storage get error:', e);
                return null;
            }
        }

        static set(key, value) {
            try {
                const data = JSON.parse(localStorage.getItem('zzxw') || '{}');
                data[key] = value;
                localStorage.setItem('zzxw', JSON.stringify(data));
            } catch (e) {
                console.error('Storage set error:', e);
            }
        }
    }

    // ===== 设置管理类 =====
    class Settings {
        static defaults = {
            home: {
                addHomeworkSource: true,
            },
            course: {
                addBatchDownload: true,
                showAllDownloadButoon: false,
                showAllCourses: true,
            },
            homework: {
                showHomeworkSource: true,
            },
            notification: {
                showMoreNotification: true,
                sortNotificationsByTime: true,
                betterNotificationHighlight: true,
            },
            preview: {
                autoDownload: false,
                autoSwitchOffice: false,
                autoSwitchPdf: true,
                autoSwitchImg: true,
                autoClosePopup: true,
                hideTimer: true,
            },
            system: {
                betterTitle: true,
                unlockCopy: true,
                showConfigButton: true,
            },
        };

        static current = {};

        static init() {
            Object.keys(this.defaults).forEach(category => {
                this.current[category] = {};
                Object.keys(this.defaults[category]).forEach(key => {
                    this.current[category][key] = GM_getValue(
                        `${category}_${key}`, 
                        this.defaults[category][key]
                    );
                });
            });
        }

        static get(category, key) {
            return this.current[category]?.[key] ?? this.defaults[category]?.[key];
        }

        static set(category, key, value) {
            if (!this.current[category]) this.current[category] = {};
            this.current[category][key] = value;
            GM_setValue(`${category}_${key}`, value);
        }
    }

    // ===== API管理类 =====
    class API {
        static getToken() {
            const cookieMap = new Map();
            document.cookie.split('; ').forEach(cookie => {
                const [key, value] = cookie.split('=');
                if (key && value) cookieMap.set(key, value);
            });
            return [cookieMap.get('iClass-uuid'), cookieMap.get('iClass-token')];
        }

        static async request(url, options = {}) {
            const [userid, token] = this.getToken();
            const defaultOptions = {
                headers: {
                    'authorization': 'Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=',
                    'blade-auth': token,
                    'content-type': 'application/json;charset=UTF-8',
                    ...options.headers
                }
            };

            try {
                const response = await fetch(url, { ...defaultOptions, ...options });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                return await response.json();
            } catch (error) {
                console.error('API request failed:', error);
                throw error;
            }
        }

        static async searchCourses(taskIds) {
            const [userid, token] = this.getToken();
            const cached = {};
            const uncachedIds = [];

            // 检查缓存
            taskIds.forEach(id => {
                const cached_result = Storage.get(id);
                if (cached_result) {
                    cached[id] = cached_result;
                } else {
                    uncachedIds.push(id);
                }
            });

            if (uncachedIds.length === 0) return cached;

            try {
                const coursesResponse = await this.request(
                    `${CONSTANTS.API_BASE}/ykt-site/site/list/student/current?size=999999&current=1&userId=${userid}&siteRoleCode=2`
                );

                const courses = coursesResponse.data.records.map(x => ({
                    id: x.id,
                    name: x.siteName,
                    teachers: x.teachers.map(y => y.name).join(', ')
                }));

                const result = { ...cached };
                let remainingIds = new Set(uncachedIds);

                // 批量搜索任务
                for (let i = 0; i < courses.length && remainingIds.size > 0; i += CONSTANTS.BATCH_SIZE_LIMIT) {
                    const batch = courses.slice(i, i + CONSTANTS.BATCH_SIZE_LIMIT);
                    const requests = batch.map(course => this.getCourseTasks(course.id));
                    
                    try {
                        const responses = await Promise.all(requests);
                        responses.forEach((response, index) => {
                            if (response?.data?.records) {
                                response.data.records.forEach(task => {
                                    // 处理作业和练习（通过task.id或task.activityId）
                                    const taskId = task.id || task.activityId;
                                    if (remainingIds.has(taskId)) {
                                        result[taskId] = batch[index];
                                        Storage.set(taskId, batch[index]);
                                        remainingIds.delete(taskId);
                                    }
                                });
                            }
                        });
                    } catch (error) {
                        console.warn('Batch request failed:', error);
                    }
                }

                return result;
            } catch (error) {
                console.error('Search courses failed:', error);
                return cached;
            }
        }

        static async getCourseTasks(siteId) {
            return this.request(`${CONSTANTS.API_BASE}/ykt-site/work/student/list`, {
                method: 'POST',
                body: JSON.stringify({
                    siteId,
                    current: 1,
                    size: 9999
                })
            });
        }
        
        // 由于没有专门的练习列表API，我们使用作业API来处理
        static async getCourseExercises(siteId) {
            try {
                // 尝试使用相同的作业API，但可能需要在解析时区分类型
                return this.getCourseTasks(siteId);
            } catch (error) {
                console.warn('Get course exercises failed:', error);
                return { data: { records: [] } };
            }
        }

        static async getUndoneList() {
            const [userid] = this.getToken();
            return this.request(`${CONSTANTS.API_BASE}/ykt-site/site/student/undone?userId=${userid}`);
        }

        static async getAssignmentDetail(id) {
            return this.request(`${CONSTANTS.API_BASE}/ykt-site/work/detail?assignmentId=${id}`);
        }

        static async getSiteResources(siteId) {
            const [userid] = this.getToken();
            const response = await this.request(`${CONSTANTS.API_BASE}/ykt-site/site-resource/tree/student?siteId=${siteId}&userId=${userid}`, {
                method: 'POST'
            });

            const resources = [];
            const extractResources = (data) => {
                if (!Array.isArray(data)) return;
                data.forEach(item => {
                    if (item.attachmentVOs) {
                        item.attachmentVOs.forEach(attachment => {
                            if (attachment.type !== 2 && attachment.resource) {
                                resources.push(attachment.resource);
                            }
                        });
                    }
                    if (item.children) {
                        extractResources(item.children);
                    }
                });
            };

            extractResources(response.data);
            return resources;
        }

        static async getPreviewURL(storageId) {
            const response = await fetch(`${CONSTANTS.API_BASE}/blade-source/resource/preview-url?resourceId=${storageId}`);
            const json = await response.json();
            return { previewUrl: json.data.previewUrl, onlinePreview: json.data.onlinePreview };
        }
    }

    // ===== 下载管理类 =====
    class DownloadManager {
        constructor() {
            this.downloading = false;
            this.sumBytes = 0;
            this.loadedBytes = 0;
        }

        async downloadFile(url, filename) {
            this.downloading = true;
            NProgress.configure({ trickle: false, speed: 0 });

            try {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const contentLength = response.headers.get('content-length');
                const total = contentLength ? parseInt(contentLength, 10) : 0;
                
                if (total > 0) {
                    this.sumBytes += total;
                }

                const reader = response.body.getReader();
                const chunks = [];

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    
                    if (!this.downloading) {
                        NProgress.done();
                        return;
                    }

                    chunks.push(value);
                    this.loadedBytes += value.length;
                    
                    if (this.sumBytes > 0) {
                        NProgress.set(this.loadedBytes / this.sumBytes);
                    }
                }

                NProgress.done();
                if (total > 0) {
                    this.sumBytes -= total;
                    this.loadedBytes -= total;
                }

                const blob = new Blob(chunks);
                const downloadUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = downloadUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(downloadUrl);

            } catch (error) {
                console.error('Download failed:', error);
                throw error;
            } finally {
                this.downloading = false;
            }
        }

        cancel() {
            this.downloading = false;
            NProgress.done();
        }
    }

    // ===== 通知管理类 =====
    class NotificationManager {
        static show(title, message, type = 'success') {
            const notification = document.createElement('div');
            const bgColor = type === 'success' ? '#4CAF50' : type === 'error' ? '#f56c6c' : '#409EFF';
            
            notification.style.cssText = `
                position: fixed;
                bottom: 80px;
                right: 20px;
                background: ${bgColor};
                color: white;
                padding: 15px 20px;
                border-radius: 8px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                z-index: 10000;
                font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
                max-width: 300px;
                opacity: 0;
                transform: translateY(-10px);
                transition: all 0.3s ease;
            `;

            notification.innerHTML = `
                <div style="font-weight: bold; margin-bottom: 5px;">${title}</div>
                <div style="font-size: 14px;">${message}</div>
            `;

            document.body.appendChild(notification);
            
            // 触发动画
            requestAnimationFrame(() => {
                notification.style.opacity = '1';
                notification.style.transform = 'translateY(0)';
            });

            setTimeout(() => {
                notification.style.opacity = '0';
                notification.style.transform = 'translateY(-10px)';
                setTimeout(() => {
                    if (notification.parentNode) {
                        document.body.removeChild(notification);
                    }
                }, 300);
            }, 3000);
        }
    }

    // ===== 课程提取管理类 =====
    class CourseExtractor {
        constructor() {
            this.courseContainer = null;
            this.originalContainer = null;
            this.allCourses = [];
        }

        async extractCourses() {
            // 获取所有轮播项
            const carouselItems = document.querySelectorAll('.el-carousel__item .my-lesson-group');
            
            if (!carouselItems || carouselItems.length === 0) {
                // 尝试使用更宽松的选择器
                const alternativeItems = document.querySelectorAll('.el-carousel__item');
                
                if (!alternativeItems || alternativeItems.length === 0) {
                    console.error('未找到课程项，请确认页面已完全加载');
                    return false;
                }
                
                // 尝试直接查找课程项
                const directCourses = document.querySelectorAll('.my-lesson-item');
                if (directCourses && directCourses.length > 0) {
                    // 使用直接找到的课程项
                    return this.extractDirectCourses(directCourses);
                }
                
                return false;
            }

            // 创建新的课程容器
            this.courseContainer = document.createElement('div');
            this.courseContainer.id = 'enhanced-courses-container';
            this.courseContainer.className = 'all-courses-container';
            this.courseContainer.style.cssText = `
                margin: 24px auto;
                padding: 24px;
                background-color: #fff;
                border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0,0,0,0.08);
                max-width: 1200px;
                transition: all 0.3s ease;
            `;

            // 创建标题
            const header = document.createElement('div');
            header.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 20px;
                border-bottom: 1px solid #ebeef5;
                padding-bottom: 15px;
            `;

            const titleSection = document.createElement('div');
            titleSection.style.cssText = `
                display: flex;
                align-items: center;
            `;

            // 添加一个小图标
            const icon = document.createElement('div');
            icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #409EFF;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
            titleSection.appendChild(icon);

            const title = document.createElement('div');
            title.textContent = '本学期全部课程';
            title.style.cssText = `
                font-size: 18px;
                font-weight: 600;
                color: #303133;
                margin-left: 10px;
            `;
            titleSection.appendChild(title);

            // 添加课程计数
            const courseCount = document.createElement('div');
            courseCount.id = 'course-count';
            courseCount.style.cssText = `
                font-size: 14px;
                color: #909399;
                background-color: #f5f7fa;
                padding: 4px 10px;
                border-radius: 4px;
            `;

            header.appendChild(titleSection);
            header.appendChild(courseCount);
            this.courseContainer.appendChild(header);

            // 创建搜索框
            const searchContainer = document.createElement('div');
            searchContainer.style.cssText = `
                margin-bottom: 20px;
            `;

            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.placeholder = '搜索课程名称或教师...';
            searchInput.style.cssText = `
                width: 100%;
                padding: 10px 15px;
                border: 1px solid #dcdfe6;
                border-radius: 4px;
                font-size: 14px;
                color: #606266;
                box-sizing: border-box;
                transition: all 0.3s;
                outline: none;
            `;

            searchInput.addEventListener('focus', function() {
                this.style.borderColor = '#409EFF';
                this.style.boxShadow = '0 0 0 2px rgba(64, 158, 255, 0.2)';
            });

            searchInput.addEventListener('blur', function() {
                this.style.borderColor = '#dcdfe6';
                this.style.boxShadow = 'none';
            });

            searchInput.addEventListener('input', () => {
                const searchTerm = searchInput.value.toLowerCase();
                const courseItems = document.querySelectorAll('.enhanced-course-item');

                let visibleCount = 0;
                courseItems.forEach(item => {
                    const courseName = item.querySelector('.my-lesson-name').textContent.toLowerCase();
                    const teacher = item.querySelector('.my-lesson-teachers').textContent.toLowerCase();

                    if (courseName.includes(searchTerm) || teacher.includes(searchTerm)) {
                        item.style.display = 'block';
                        visibleCount++;
                    } else {
                        item.style.display = 'none';
                    }
                });

                // 更新课程计数
                this.updateCourseCount(visibleCount);
            });

            searchContainer.appendChild(searchInput);
            this.courseContainer.appendChild(searchContainer);

            // 创建课程列表容器
            const coursesContainer = document.createElement('div');
            coursesContainer.style.cssText = `
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                gap: 20px;
                justify-content: center;
            `;
            this.courseContainer.appendChild(coursesContainer);

            // 提取所有课程
            this.allCourses = [];
            carouselItems.forEach((group, index) => {
                const courses = group.querySelectorAll('.my-lesson-item');
                
                courses.forEach(course => {
                    const clonedCourse = this.createEnhancedCourse(course);
                    this.allCourses.push(clonedCourse);
                });
            });

            // 将所有课程添加到新容器
            this.allCourses.forEach(course => {
                coursesContainer.appendChild(course);
            });

            return this.allCourses.length > 0;
        }
        
        // 直接从课程项提取
        extractDirectCourses(courseItems) {
            // 创建新的课程容器
            this.courseContainer = document.createElement('div');
            this.courseContainer.id = 'enhanced-courses-container';
            this.courseContainer.className = 'all-courses-container';
            this.courseContainer.style.cssText = `
                margin: 24px auto;
                padding: 24px;
                background-color: #fff;
                border-radius: 8px;
                box-shadow: 0 4px 16px rgba(0,0,0,0.08);
                max-width: 1200px;
                transition: all 0.3s ease;
            `;

            // 创建标题
            const header = document.createElement('div');
            header.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 20px;
                border-bottom: 1px solid #ebeef5;
                padding-bottom: 15px;
            `;

            const titleSection = document.createElement('div');
            titleSection.style.cssText = `
                display: flex;
                align-items: center;
            `;

            // 添加一个小图标
            const icon = document.createElement('div');
            icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #409EFF;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path></svg>`;
            titleSection.appendChild(icon);

            const title = document.createElement('div');
            title.textContent = '本学期全部课程';
            title.style.cssText = `
                font-size: 18px;
                font-weight: 600;
                color: #303133;
                margin-left: 10px;
            `;
            titleSection.appendChild(title);

            // 添加课程计数
            const courseCount = document.createElement('div');
            courseCount.id = 'course-count';
            courseCount.style.cssText = `
                font-size: 14px;
                color: #909399;
                background-color: #f5f7fa;
                padding: 4px 10px;
                border-radius: 4px;
            `;

            header.appendChild(titleSection);
            header.appendChild(courseCount);
            this.courseContainer.appendChild(header);

            // 创建搜索框
            const searchContainer = document.createElement('div');
            searchContainer.style.cssText = `
                margin-bottom: 20px;
            `;

            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.placeholder = '搜索课程名称或教师...';
            searchInput.style.cssText = `
                width: 100%;
                padding: 10px 15px;
                border: 1px solid #dcdfe6;
                border-radius: 4px;
                font-size: 14px;
                color: #606266;
                box-sizing: border-box;
                transition: all 0.3s;
                outline: none;
            `;

            searchInput.addEventListener('focus', function() {
                this.style.borderColor = '#409EFF';
                this.style.boxShadow = '0 0 0 2px rgba(64, 158, 255, 0.2)';
            });

            searchInput.addEventListener('blur', function() {
                this.style.borderColor = '#dcdfe6';
                this.style.boxShadow = 'none';
            });

            searchInput.addEventListener('input', () => {
                const searchTerm = searchInput.value.toLowerCase();
                const courseItems = document.querySelectorAll('.enhanced-course-item');

                let visibleCount = 0;
                courseItems.forEach(item => {
                    const courseName = item.querySelector('.my-lesson-name').textContent.toLowerCase();
                    const teacher = item.querySelector('.my-lesson-teachers').textContent.toLowerCase();

                    if (courseName.includes(searchTerm) || teacher.includes(searchTerm)) {
                        item.style.display = 'block';
                        visibleCount++;
                    } else {
                        item.style.display = 'none';
                    }
                });

                // 更新课程计数
                this.updateCourseCount(visibleCount);
            });

            searchContainer.appendChild(searchInput);
            this.courseContainer.appendChild(searchContainer);

            // 创建课程列表容器
            const coursesContainer = document.createElement('div');
            coursesContainer.style.cssText = `
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                gap: 20px;
                justify-content: center;
            `;
            this.courseContainer.appendChild(coursesContainer);

            // 提取所有课程
            this.allCourses = [];
            courseItems.forEach(course => {
                const clonedCourse = this.createEnhancedCourse(course);
                this.allCourses.push(clonedCourse);
            });

            // 将所有课程添加到新容器
            this.allCourses.forEach(course => {
                coursesContainer.appendChild(course);
            });

            return this.allCourses.length > 0;
        }

        createEnhancedCourse(course) {
            const clonedCourse = course.cloneNode(true);
            clonedCourse.classList.add('enhanced-course-item');

            // 隐藏原图片
            const img = clonedCourse.querySelector('.my-lesson-post');
            if (img) {
                img.style.display = 'none';
            }

            // 生成随机浅色背景
            const hue = Math.floor(Math.random() * 360);
            const pastelColor = `hsl(${hue}, 70%, 95%)`;
            const darkerColor = `hsl(${hue}, 70%, 90%)`;

            // 创建一个小图标作为视觉元素
            const courseIcon = document.createElement('div');
            courseIcon.style.cssText = `
                width: 40px;
                height: 40px;
                border-radius: 8px;
                background-color: ${pastelColor};
                display: flex;
                align-items: center;
                justify-content: center;
                margin-bottom: 12px;
                color: hsl(${hue}, 70%, 40%);
                font-weight: bold;
                font-size: 18px;
            `;

            // 获取课程名称的首字母作为图标文本
            const courseName = clonedCourse.querySelector('.my-lesson-name').textContent.trim();
            courseIcon.textContent = courseName.charAt(0);

            // 调整样式以适应新的布局
            clonedCourse.style.cssText = `
                height: auto;
                padding: 16px;
                background-color: #ffffff;
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                margin: 0;
                transition: all 0.3s;
                display: flex;
                flex-direction: column;
                border: 1px solid #ebeef5;
                position: relative;
                overflow: hidden;
            `;

            // 在卡片底部添加一个彩色条纹
            const colorStrip = document.createElement('div');
            colorStrip.style.cssText = `
                position: absolute;
                bottom: 0;
                left: 0;
                height: 4px;
                width: 100%;
                background-color: ${darkerColor};
            `;
            clonedCourse.appendChild(colorStrip);

            // 将现有内容包装在div中
            const contentWrapper = document.createElement('div');

            // 移动现有内容到包装器
            while (clonedCourse.firstChild && clonedCourse.firstChild !== colorStrip) {
                contentWrapper.appendChild(clonedCourse.firstChild);
            }

            // 重新组织内容
            clonedCourse.appendChild(courseIcon);
            clonedCourse.appendChild(contentWrapper);

            // 确保文本内容可见并样式正确
            const courseNameElem = contentWrapper.querySelector('.my-lesson-name');
            const courseTeachers = contentWrapper.querySelector('.my-lesson-teachers');
            const courseArea = contentWrapper.querySelector('.my-lesson-area');

            if (courseNameElem) {
                courseNameElem.style.cssText = `
                    font-size: 15px;
                    font-weight: 600;
                    color: #303133;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;  /* 确保文本不换行 */
                    display: block;  /* 使元素为块级元素 */
                    width: 100%;  /* 确保容器宽度限制 */
                    margin-bottom: 8px;
                    line-height: 1.4;
                 `;

                // 为课程名称添加 title 属性，悬停时显示完整课程名
                courseNameElem.setAttribute('title', courseName);
            }

            if (courseTeachers) {
                courseTeachers.style.cssText = `
                    font-size: 13px;
                    color: #606266;
                    margin-top: 5px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    display: flex;
                    align-items: center;
                `;

                // 添加教师图标
                const teacherIcon = document.createElement('span');
                teacherIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;margin-top: 4px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
                courseTeachers.insertBefore(teacherIcon, courseTeachers.firstChild);
            }

            if (courseArea) {
                courseArea.style.cssText = `
                    font-size: 13px;
                    color: #909399;
                    margin-top: 8px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    display: flex;
                    align-items: center;
                `;

                // 添加区域图标
                const areaIcon = document.createElement('span');
                areaIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;margin-top: 4px;"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
                courseArea.insertBefore(areaIcon, courseArea.firstChild);
            }

            // 鼠标悬停效果
            clonedCourse.addEventListener('mouseover', function() {
                this.style.backgroundColor = '#f9fafc';
                this.style.boxShadow = '0 6px 16px rgba(0,0,0,0.1)';
                this.style.transform = 'translateY(-2px)';
            });

            clonedCourse.addEventListener('mouseout', function() {
                this.style.backgroundColor = '#ffffff';
                this.style.boxShadow = '0 2px 8px rgba(0,0,0,0.05)';
                this.style.transform = 'translateY(0)';
            });

            // 添加点击事件 - 跳转到原课程链接
            clonedCourse.style.cursor = 'pointer';
            clonedCourse.addEventListener('click', function() {
                // 获取课程名称用于查找原始元素
                const name = this.querySelector('.my-lesson-name').textContent.trim();

                // 查找原始课程元素
                const originalCourses = document.querySelectorAll('.my-lesson-item');
                for (let i = 0; i < originalCourses.length; i++) {
                    const originalName = originalCourses[i].querySelector('.my-lesson-name').textContent.trim();
                    if (originalName === name) {
                        originalCourses[i].click();
                        break;
                    }
                }
            });
            
            return clonedCourse;
        }

        displayCourses() {
            // 检查是否已有相同ID的容器存在
            if (document.getElementById('enhanced-courses-container')) {
                return true;
            }
            
            // 获取原始课程容器的父元素
            this.originalContainer = document.querySelector('.my-lesson-section');
            if (!this.originalContainer) {
                console.error('找不到原始课程容器');
                return false;
            }
            
            // 先检查下分页元素
            const pagination = document.querySelector('.el-pagination');
            if (pagination) {
                pagination.style.display = 'none';
            }
            
            if (this.originalContainer && this.originalContainer.parentNode) {
                // 在原始容器后面插入新容器
                this.originalContainer.parentNode.insertBefore(this.courseContainer, this.originalContainer.nextSibling);
                
                // 更新课程计数
                this.updateCourseCount(this.allCourses.length);
                
                return true;
            }
            
            console.error('无法找到合适的位置插入课程容器');
            return false;
        }

        toggleOriginalContainer(show) {
            if (this.originalContainer) {
                this.originalContainer.style.display = show ? 'block' : 'none';
                
                // 同时处理分页元素
                const pagination = document.querySelector('.el-pagination');
                if (pagination) {
                    pagination.style.display = show ? 'block' : 'none';
                }
            }
        }

        updateCourseCount(count) {
            const countElement = document.getElementById('course-count');
            if (countElement) {
                countElement.textContent = `共 ${count} 门课程`;
            }
        }
    }

    // ===== 主应用类 =====
    class UCloudEnhancer {
        constructor() {
            this.downloadManager = new DownloadManager();
            this.courseExtractor = new CourseExtractor(); // 新增课程提取器
            this.currentPage = location.href;
            this.observers = new Set();
        }

        init() {
            Settings.init();
            this.setupInterceptors();
            this.loadStyles();
            this.createUI();
            this.registerMenuCommands();

            this.handleCurrentPage();
            this.setupPageChangeListener();
            
            // 为课程页面添加一个专门的初始化机制
            this.initForCoursePage();
        }
        
        // 专门针对课程页面的初始化
        initForCoursePage() {
            // 检查当前URL是否匹配课程页面
            const isCoursePage = location.href.includes('uclass/index.html#/student') || 
                               location.href.includes('uclass/#/student') ||
                               location.href.includes('uclass/index.html#/') ||
                               location.href.includes('uclass/#/');
                               
            if (!isCoursePage) return;
            
            // 等待DOM完全加载
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', () => {
                    setTimeout(() => this.handleCoursesPage(), 500);
                });
            } else {
                // 如果DOM已经加载完成，设置一个延时保证动态内容已加载
                setTimeout(() => this.handleCoursesPage(), 500);
            }
            
            // 监听页面变化，防止单页应用导航变化不触发刷新
            const observer = new MutationObserver(
                Utils.debounce(() => {
                    if (document.querySelector('.my-lesson-section') && 
                        !document.getElementById('enhanced-courses-container')) {
                        this.handleCoursesPage();
                    }
                }, 500)
            );
            
            observer.observe(document.body, {
                childList: true, 
                subtree: true
            });
            
            this.observers.add(observer);
        }

        setupInterceptors() {
            // XHR拦截器
            const originalOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
                if (Settings.get('notification', 'showMoreNotification')) {
                    if (typeof url === 'string') {
                        if (url.includes('/ykt-basics/api/inform/news/list')) {
                            url = url.replace(/size=\d+/, 'size=1000');
                        } else if (url.includes('/ykt-site/site/list/student/history')) {
                            url = url.replace(/size=\d+/, 'size=15');
                        }
                    }
                }
                return originalOpen.call(this, method, url, async, user, password);
            };
        }

        loadStyles() {
            const nprogressCSS = GM_getResourceText('NPROGRESS_CSS');
            GM_addStyle(nprogressCSS);
            
            // 基础样式
            GM_addStyle(`
                .course-info-badge {
                    display: inline-block;
                    padding: 2px 8px;
                    font-size: 12px;
                    font-weight: 500;
                    line-height: 1.5;
                    color: #57606a;
                    background-color: #f1f2f4;
                    border-radius: 12px;
                    margin-bottom: 5px;
                    max-width: fit-content;
                }
                
                .course-info-badge-detail {
                    display: inline-block;
                    padding: 2px 8px;
                    font-size: 13px;
                    font-weight: 500;
                    color: #444;
                    background-color: #f0f2f5;
                    border: 1px solid #d9d9d9;
                    border-radius: 6px;
                    transform: translateY(-5px);
                }
                
                .teacher-home-page .home-left-container .in-progress-section .in-progress-body .in-progress-item .activity-box > div:first-child {
                    flex-direction: column !important;
                    justify-content: center !important;
                    height: 100% !important;
                }
                
                .teacher-home-page .home-left-container .in-progress-section .in-progress-body .in-progress-item .activity-box .activity-title {
                    height: auto !important;
                    white-space: normal !important;
                }
                
                #layout-container > div.main-content > div.router-container > div > div.my-course-page {
                    max-height: none !important;
                }
                
                .teacher-home-page .home-left-container .in-progress-section .in-progress-body .in-progress-item {
                    height: auto !important;
                    padding-bottom: 12px !important;
                }
            `);

            // 可选样式
            if (Settings.get('notification', 'betterNotificationHighlight')) {
                GM_addStyle(`
                    .notification-with-dot {
                        background-color: #fff8f8 !important;
                        border-left: 5px solid #f56c6c !important;
                        box-shadow: 0 2px 6px rgba(245, 108, 108, 0.2) !important;
                        padding: 0 22px !important;
                        margin-bottom: 8px !important;
                        border-radius: 4px !important;
                        transition: all 0.3s ease !important;
                    }
                    
                    .notification-with-dot:hover {
                        background-color: #fff0f0 !important;
                        box-shadow: 0 4px 12px rgba(245, 108, 108, 0.3) !important;
                        transform: translateY(-2px) !important;
                    }
                `);
            }

            if (Settings.get('system', 'unlockCopy')) {
                GM_addStyle(`
                    .el-checkbox, .el-checkbox-button__inner, .el-empty__image img, .el-radio,
                    div, span, p, a, h1, h2, h3, h4, h5, h6, li, td, th {
                        -webkit-user-select: auto !important;
                        -moz-user-select: auto !important;
                        -ms-user-select: auto !important;
                        user-select: auto !important;
                    }
                `);

                // 解除复制限制事件
                document.addEventListener('copy', e => e.stopImmediatePropagation(), true);
                document.addEventListener('selectstart', e => e.stopImmediatePropagation(), true);
            }
        }

        setupPageChangeListener() {
            let currentHash = location.hash;
            const checkHashChange = () => {
                if (location.hash !== currentHash) {
                    currentHash = location.hash;
                    this.currentPage = location.href;
                    this.handleCurrentPage();
                }
            };
            setInterval(checkHashChange, 100);
        }

        async handleCurrentPage() {
            const url = this.currentPage;
            
            try {
                // Office预览重定向
                if (url.startsWith(CONSTANTS.URLS.office)) {
                    await this.handleOfficeRedirect();
                    return;
                }

                // 课件预览页面
                if (url.startsWith(CONSTANTS.URLS.resourceLearn)) {
                    this.handleResourcePreview();
                    return;
                }

                // 作业详情页面
                if (url.startsWith(CONSTANTS.URLS.assignmentDetails)) {
                    await this.handleAssignmentDetails();
                    return;
                }

                // 主页面
                if (url.startsWith(CONSTANTS.URLS.home) || url.startsWith(CONSTANTS.URLS.homeFallback)) {
                    await this.handleHomePage();
                    return;
                }

                // 课程主页
                if (url.startsWith(CONSTANTS.URLS.courseHome)) {
                    await this.handleCourseHome();
                    return;
                }

                // 通知页面
                if (url === CONSTANTS.URLS.notification) {
                    this.handleNotificationPage();
                    return;
                }

                // 根页面
                if (url === 'https://ucloud.bupt.edu.cn/#/') {
                    this.handleRootPage();
                    return;
                }

                // 学生课程页面 - 新增处理课程列表页面
                if (url.includes('uclass/index.html#/student') || 
                    url.includes('uclass/#/student') || 
                    url.includes('uclass/index.html#/') || 
                    url.includes('uclass/#/')) {
                    await this.handleCoursesPage();
                    return;
                }
            } catch (error) {
                console.error('Handle page error:', error);
            }
        }

        async handleOfficeRedirect() {
            const urlParams = new URLSearchParams(location.search);
            const fileUrl = urlParams.get('furl');
            const filename = urlParams.get('fullfilename') || fileUrl;
            
            if (!fileUrl || !filename) return;

            const viewURL = new URL(fileUrl);
            const oauthKey = urlParams.get('oauthKey');
            if (oauthKey) {
                const viewURLsearch = new URLSearchParams(viewURL.search);
                viewURLsearch.set('oauthKey', oauthKey);
                viewURL.search = viewURLsearch.toString();
            }

            // Office文件重定向
            if (Utils.hasFileExtension(filename, CONSTANTS.FILE_EXTENSIONS.office)) {
                if (!Settings.get('preview', 'autoSwitchOffice')) return;
                if (window.stop) window.stop();
                location.href = CONSTANTS.OFFICE_PREVIEW_BASE + encodeURIComponent(viewURL.toString());
                return;
            }

            // PDF文件重定向
            if (Utils.hasFileExtension(filename, CONSTANTS.FILE_EXTENSIONS.pdf)) {
                if (!Settings.get('preview', 'autoSwitchPdf')) return;
                if (window.stop) window.stop();
                try {
                    const response = await fetch(viewURL.toString());
                    const blob = await response.blob();
                    const blobUrl = URL.createObjectURL(blob);
                    location.href = blobUrl;
                } catch (err) {
                    console.error('PDF加载失败:', err);
                }
                return;
            }

            // 图片文件重定向
            if (Utils.hasFileExtension(filename, CONSTANTS.FILE_EXTENSIONS.image)) {
                if (!Settings.get('preview', 'autoSwitchImg')) return;
                if (window.stop) window.stop();
                this.createImageViewer(viewURL.toString());
                return;
            }
        }

        handleResourcePreview() {
            if (Settings.get('system', 'betterTitle')) {
                const filename = this.extractFilenameFromPreviewUrl(location.href);
                document.title = `[预览] ${filename || '课件'} - 教学云空间`;
            }

            if (Settings.get('preview', 'autoClosePopup')) {
                this.autoClosePreviewPopup();
            }

            if (Settings.get('preview', 'hideTimer')) {
                GM_addStyle('.preview-container .time { display: none !important; }');
            }
        }

        async handleAssignmentDetails() {
            const urlParams = new URLSearchParams(location.href);
            const assignmentId = urlParams.get('assignmentId');
            const title = urlParams.get('assignmentTitle');

            if (Settings.get('system', 'betterTitle')) {
                document.title = `[作业] ${title} - 教学云空间`;
            }

            // 自动切换到"作业信息"标签页
            this.autoSwitchToAssignmentInfoTab();

            if (!assignmentId || !Settings.get('homework', 'showHomeworkSource')) return;

            try {
                // 检查缓存
                let courseInfo = Storage.get(assignmentId);
                if (!courseInfo) {
                    const [userid, token] = API.getToken();
                    const courses = await API.searchCourses([assignmentId]);
                    courseInfo = courses[assignmentId];
                }

                if (courseInfo) {
                    this.insertCourseInfo(courseInfo);
                }

                // 处理资源预览和下载
                await this.handleAssignmentResources(assignmentId);
            } catch (error) {
                console.error('Handle assignment details error:', error);
            }
        }

        async handleHomePage() {
            if (Settings.get('system', 'betterTitle')) {
                document.title = '个人主页 - 教学云空间';
            }

            if (!Settings.get('home', 'addHomeworkSource')) return;

            try {
                const undoneList = await API.getUndoneList();
                const assignments = undoneList.data?.undoneList;
                if (!assignments?.length) return;

                // 创建统一的作业显示视图
                await this.createUnifiedHomeworkView(assignments);
            } catch (error) {
                console.error('Handle home page error:', error);
            }
        }

        async handleCourseHome() {
            const site = JSON.parse(localStorage.getItem('site') || '{}');
            if (!site.id) return;

            if (Settings.get('system', 'betterTitle')) {
                document.title = `[课程] ${site.siteName} - 教学云空间`;
            }

            try {
                const resources = await API.getSiteResources(site.id);
                await this.setupCourseResources(resources);
            } catch (error) {
                console.error('Handle course home error:', error);
            }
        }

        handleNotificationPage() {
            if (Settings.get('system', 'betterTitle')) {
                document.title = '通知 - 教学云空间';
            }

            if (Settings.get('notification', 'sortNotificationsByTime') || 
                Settings.get('notification', 'betterNotificationHighlight')) {
                this.processNotifications();
            }
        }

        handleRootPage() {
            if (Settings.get('system', 'betterTitle')) {
                document.title = '首页 - 教学云空间';
            }
        }

        // ===== 统一作业视图 =====

        async createUnifiedHomeworkView(assignments) {
            // 等待原有作业区域加载
            await Utils.wait(() => document.querySelector('.in-progress-section'), 5000);
            
            try {
                // 调试：打印完整的assignments数据
                console.log('Complete assignments data:', assignments);
                console.log('First assignment structure:', assignments[0]);
                
                // 从DOM中补充作业信息
                const enrichedAssignments = await this.enrichAssignmentsFromDOM(assignments);
                
                // 获取所有作业和练习的ID
                const taskIds = enrichedAssignments.map(x => x.activityId);
                
                // 将siteName信息添加到assignments中
                enrichedAssignments.forEach(assignment => {
                    if (assignment.siteName && !assignment.courseInfo) {
                        assignment.courseInfo = {
                            name: assignment.siteName,
                            teachers: ''
                        };
                    }
                });
                
                // 获取所有作业的课程信息
                const courseInfos = await API.searchCourses(taskIds);

                // 创建统一作业视图
                this.insertUnifiedHomeworkPanel(enrichedAssignments, courseInfos);
            } catch (error) {
                console.error('Create unified homework view error:', error);
                // 如果创建失败，回退到原有方式
                this.setupHomeworkSourceDisplay(assignments);
            }
        }

        async enrichAssignmentsFromDOM(assignments) {
            try {
                // 等待DOM加载
                await Utils.wait(() => document.querySelector('.in-progress-body'), 3000);
                
                // 获取所有作业DOM元素
                const homeworkElements = document.querySelectorAll('.in-progress-item');
                
                console.log(`Found ${homeworkElements.length} homework elements in DOM`);
                
                // 从DOM中提取作业信息
                const domHomeworks = Array.from(homeworkElements).map((element, index) => {
                    const titleElement = element.querySelector('.activity-title');
                    const deadlineElement = element.querySelector('.acitivity-dateline');
                    
                    const title = titleElement ? titleElement.textContent.trim() : null;
                    const deadlineText = deadlineElement ? deadlineElement.textContent.trim() : null;
                    
                    // 解析截止时间
                    let deadline = null;
                    if (deadlineText) {
                        const match = deadlineText.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
                        if (match) {
                            deadline = match[1];
                        }
                    }
                    
                    // 检查是否为练习类型（通过图标或其他特征）
                    const isExercise = element.querySelector('img[src*="data:image/png;base64"]') !== null;
                    
                    return {
                        domTitle: title,
                        domDeadline: deadline,
                        domIndex: index,
                        isExercise
                    };
                });
                
                console.log('DOM homework data:', domHomeworks);
                
                // 将DOM数据与API数据合并
                const enriched = assignments.map((assignment, index) => {
                    const domData = domHomeworks[index] || {};
                    
                    // 判断是否为练习类型（优先使用API数据，其次使用DOM特征）
                    const isExercise = assignment.type === 4 || domData.isExercise;
                    
                    return {
                        ...assignment,
                        // 优先使用DOM中的标题，然后是API中的activityName字段
                        title: domData.domTitle || assignment.activityName || assignment.title || assignment.name || assignment.assignmentTitle || assignment.activityTitle || `${isExercise ? '练习' : '作业'} ${index + 1}`,
                        // 优先使用DOM中的截止时间
                        endTime: domData.domDeadline || assignment.endTime || assignment.deadline || assignment.dueTime,
                        // 确保type字段存在
                        type: assignment.type || (isExercise ? 4 : 1)
                    };
                });
                
                console.log('Enriched assignments:', enriched);
                console.log('Final titles extracted:', enriched.map((a, i) => `${i}: ${a.title || a.activityName || 'NO TITLE'}`));
                return enriched;
                
            } catch (error) {
                console.error('Error enriching assignments from DOM:', error);
                return assignments;
            }
        }

        insertUnifiedHomeworkPanel(assignments, courseInfos) {
            // 检查是否已经存在统一视图
            if (document.getElementById('unified-homework-panel')) return;

            const inProgressSection = document.querySelector('.in-progress-section');
            if (!inProgressSection) return;

            // 不再需要保存原始作业项，直接使用URL跳转

            // 保存原始的整个section内容
            const originalSectionContent = inProgressSection.outerHTML;
            inProgressSection.setAttribute('data-original-section', originalSectionContent);

            // 创建新的统一视图容器，完全替换原来的section
            const unifiedPanel = document.createElement('div');
            unifiedPanel.id = 'unified-homework-panel';
            unifiedPanel.className = 'unified-homework-container';
            unifiedPanel.innerHTML = `
                <div class="unified-homework-header">
                    <div class="title-section">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 10px; color: #409EFF;">
                            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                        </svg>
                        <h3 class="unified-homework-title">全部待办作业</h3>
                    </div>
                    <div class="unified-homework-actions">
                        <div class="homework-count" id="homework-count">共 ${assignments.length} 项作业</div>
                    </div>
                </div>
                <div class="search-container">
                    <input type="text" id="homework-search" placeholder="搜索作业标题或课程名称..." />
                </div>
                <div class="unified-homework-list">
                    ${this.generateHomeworkListHTML(assignments, courseInfos)}
                </div>
            `;

            // 完全替换整个section
            inProgressSection.parentNode.replaceChild(unifiedPanel, inProgressSection);

            // 添加样式
            this.addUnifiedHomeworkStyles();

            // 等待DOM渲染完成后绑定事件
            setTimeout(() => {
                const homeworkCards = unifiedPanel.querySelectorAll('.unified-homework-card');
                console.log('Found homework cards:', homeworkCards.length);
                
                homeworkCards.forEach((card, index) => {
                    console.log(`Binding event to card ${index}:`, card);
                    card.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        
                        const assignmentId = card.getAttribute('data-assignment-id');
                        const title = card.getAttribute('data-assignment-title');
                        const type = card.getAttribute('data-assignment-type') || 'assignment';
                        
                        console.log('Card clicked:', { assignmentId, title, type });
                        
                        if (assignmentId && title) {
                            this.openAssignmentDetails(assignmentId, title, type);
                        }
                    });
                });

                // 添加搜索功能
                const searchInput = unifiedPanel.querySelector('#homework-search');
                const updateHomeworkCount = (count) => {
                    const countElement = unifiedPanel.querySelector('#homework-count');
                    if (countElement) {
                        countElement.textContent = `共 ${count} 项作业`;
                    }
                };

                if (searchInput) {
                    searchInput.addEventListener('input', function() {
                        const searchTerm = this.value.toLowerCase();
                        const homeworkCards = unifiedPanel.querySelectorAll('.unified-homework-card');
                        
                        let visibleCount = 0;
                        homeworkCards.forEach(card => {
                            const title = card.querySelector('.homework-title').textContent.toLowerCase();
                            const course = card.querySelector('.homework-course span').textContent.toLowerCase();
                            
                            if (title.includes(searchTerm) || course.includes(searchTerm)) {
                                card.style.display = 'flex';
                                visibleCount++;
                            } else {
                                card.style.display = 'none';
                            }
                        });
                        
                        updateHomeworkCount(visibleCount);
                    });
                }
            }, 100);
        }

            generateHomeworkListHTML(assignments, courseInfos) {
        return assignments.map((assignment, index) => {
                // 判断是否为练习类型
                const isExercise = assignment.type === 4;
                const activityType = isExercise ? 'exercise' : 'assignment';
                
                // 获取课程信息
                const courseInfo = courseInfos[assignment.activityId];
                // 如果有siteName，直接使用，否则使用courseInfo
                const courseName = assignment.siteName ? assignment.siteName : 
                                  (courseInfo ? `${courseInfo.name}` : '课程信息加载中...');
                const teacherName = courseInfo ? courseInfo.teachers : '';
                
                // 获取作业标题（优先使用处理后的title，备用activityName）
                const title = assignment.title || assignment.activityName || `${isExercise ? '练习' : '作业'} ${index + 1}`;
                
                // 格式化截止时间
                let deadline = '无截止时间';
                let deadlineShort = '无期限';
                if (assignment.endTime) {
                    try {
                        // 如果是字符串格式的时间（来自DOM）
                        if (typeof assignment.endTime === 'string' && assignment.endTime.includes('-')) {
                            deadline = assignment.endTime;
                            // 显示完整的月-日 时:分格式
                            const parts = assignment.endTime.split(' ');
                            if (parts.length >= 2) {
                                const datePart = parts[0].split('-').slice(1).join('-'); // MM-DD
                                const timePart = parts[1].split(':').slice(0, 2).join(':'); // HH:MM
                                deadlineShort = `${datePart} ${timePart}`;
                            } else {
                                deadlineShort = assignment.endTime.split(' ')[0]; // 只取日期部分
                            }
                        } else {
                            // 如果是时间戳格式
                            const date = new Date(assignment.endTime);
                            deadline = date.toLocaleString('zh-CN', {
                                year: 'numeric',
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit'
                            });
                            deadlineShort = date.toLocaleString('zh-CN', {
                                month: '2-digit',
                                day: '2-digit',
                                hour: '2-digit',
                                minute: '2-digit'
                            });
                        }
                    } catch (e) {
                        console.warn('Time format error:', assignment.endTime);
                        deadline = '时间格式错误';
                        deadlineShort = '错误';
                    }
                }

                // 判断紧急程度
                let statusClass = 'normal';
                let statusText = '正常';
                if (assignment.endTime) {
                    try {
                        const endDate = new Date(assignment.endTime);
                        const now = new Date();
                        const timeDiff = endDate - now;
                        
                        if (timeDiff < 0) {
                            statusClass = 'overdue';
                            statusText = '已逾期';
                        } else if (timeDiff < 7 * 60 * 60 * 1000) {
                            statusClass = 'urgent';
                            statusText = '即将到期';
                        }
                    } catch (e) {
                        // 时间解析失败，不设置紧急状态
                    }
                }

                // 添加类型标识
                const typeLabel = isExercise ? '练习' : '作业';

                return `
                    <div class="unified-homework-card ${statusClass}" 
                         data-assignment-id="${assignment.activityId}" 
                         data-assignment-title="${title.replace(/"/g, '&quot;').replace(/'/g, '&#39;')}"
                         data-assignment-type="${activityType}">
                        <div class="homework-info">
                            <h4 class="homework-title" title="${title}">${title}</h4>
                            <div class="homework-course">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"></path>
                                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"></path>
                                </svg>
                                <span>${courseName}</span>
                            </div>
                            ${teacherName ? `<div class="homework-teacher">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="12" cy="7" r="4"></circle>
                                </svg>
                                <span>${teacherName}</span>
                            </div>` : ''}
                            <div class="homework-deadline">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <polyline points="12,6 12,12 16,14"></polyline>
                                </svg>
                                <span>${deadlineShort}</span>
                            </div>
                        </div>
                        <div class="homework-status-badge ${statusClass}">
                            ${typeLabel} - ${statusText}
                        </div>
                    </div>
                `;
            }).join('');
        }

        addUnifiedHomeworkStyles() {
            GM_addStyle(`
                .unified-homework-container {
                    background: linear-gradient(135deg, #fff 0%, #fafbfc 100%);
                    border-radius: 16px;
                    box-shadow: 0 4px 20px rgba(64, 158, 255, 0.08), 0 1px 8px rgba(64, 158, 255, 0.05);
                    border: 1px solid rgba(64, 158, 255, 0.1);
                    margin: 24px auto 0;
                    padding: 0;
                    max-width: 1200px;
                    transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                    backdrop-filter: blur(10px);
                    position: relative;
                    overflow: hidden;
                }

                .unified-homework-container::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 1px;
                    background: linear-gradient(90deg, transparent, rgba(64, 158, 255, 0.3), transparent);
                }

                .unified-homework-header {
                    background: linear-gradient(135deg, rgba(255,255,255,0.9) 0%, rgba(250,251,252,0.9) 100%);
                    color: #303133;
                    padding: 20px 24px 16px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    border-bottom: 1px solid rgba(235, 238, 245, 0.5);
                    backdrop-filter: blur(20px);
                }

                .title-section {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .unified-homework-title {
                    margin: 0;
                    font-size: 18px;
                    font-weight: 700;
                    color: #1a1a1a;
                    letter-spacing: -0.02em;
                    background: linear-gradient(135deg, #303133 0%, #606266 100%);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }

                .unified-homework-actions {
                    display: flex;
                    align-items: center;
                    gap: 12px;
                }

                .homework-count {
                    font-size: 14px;
                    color: #909399;
                    background-color: #f5f7fa;
                    padding: 4px 10px;
                    border-radius: 4px;
                }

                .search-container {
                    padding: 16px 24px;
                }

                .search-container input {
                    width: 100%;
                    padding: 10px 15px;
                    border: 1px solid #dcdfe6;
                    border-radius: 4px;
                    font-size: 14px;
                    color: #606266;
                    box-sizing: border-box;
                    transition: all 0.3s;
                    outline: none;
                }

                .search-container input:focus {
                    border-color: #409EFF;
                    box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.2);
                }

                .unified-homework-list {
                    max-height: 70vh;
                    overflow-y: auto;
                    overflow-x: hidden;
                    padding: 12px 20px 24px;
                    background: transparent;
                    display: grid;
                    // grid-template-columns: repeat(3, 1fr);
                    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                    gap: 20px;
                    justify-content: center;
                }

                .unified-homework-card {
                    height: auto;
                    padding: 16px;
                    background-color: #ffffff;
                    border-radius: 8px;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.05);
                    margin: 0;
                    transition: all 0.3s;
                    display: flex;
                    flex-direction: column;
                    border: 1px solid #ebeef5;
                    position: relative;
                    overflow: hidden;
                    cursor: pointer;
                }

                .unified-homework-card:hover {
                    background-color: #f9fafc;
                    box-shadow: 0 6px 16px rgba(0,0,0,0.1);
                    transform: translateY(-2px);
                }

                .unified-homework-card.urgent {
                    border-left: 4px solid #ffe6b3;
                    background-color: #ffffff;
                }

                .unified-homework-card.overdue {
                    border-left: 4px solid #ffd6d6;
                    background-color: #ffffff;
                }

                .homework-info {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }

                .homework-title {
                    margin: 0 0 12px 0;
                    font-size: 15px;
                    font-weight: 600;
                    color: #303133;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    display: block;
                    width: 100%;
                    line-height: 1.4;
                    padding-right: 70px;
                    max-width: 100%;
                }

                .homework-course,
                .homework-teacher,
                .homework-deadline {
                    font-size: 13px;
                    color: #606266;
                    display: flex;
                    align-items: center;
                    gap: 4px;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    white-space: nowrap;
                    font-weight: 400;
                }

                .homework-course svg,
                .homework-teacher svg,
                .homework-deadline svg {
                    flex-shrink: 0;
                    opacity: 0.7;
                }

                .homework-status-badge {
                    position: absolute;
                    top: 12px;
                    right: 12px;
                    font-size: 11px;
                    font-weight: 600;
                    padding: 2px 8px;
                    border-radius: 12px;
                    background: #f5f7fa;
                    color: #909399;
                }

                .homework-status-badge.urgent {
                    background: #fff7e6;
                    color: #b26a00;
                    border: none;
                }

                .homework-status-badge.overdue {
                    background: #fff0f0;
                    color: #c0392b;
                    border: none;
                }



                /* 现代化滚动条样式 */
                .unified-homework-list::-webkit-scrollbar {
                    width: 8px;
                }

                .unified-homework-list::-webkit-scrollbar-track {
                    background: rgba(245, 247, 250, 0.3);
                    border-radius: 10px;
                    margin: 16px 0;
                }

                .unified-homework-list::-webkit-scrollbar-thumb {
                    background: linear-gradient(135deg, rgba(64, 158, 255, 0.3) 0%, rgba(64, 158, 255, 0.2) 100%);
                    border-radius: 10px;
                    border: 2px solid transparent;
                    background-clip: content-box;
                    transition: all 0.3s ease;
                }

                .unified-homework-list::-webkit-scrollbar-thumb:hover {
                    background: linear-gradient(135deg, rgba(64, 158, 255, 0.5) 0%, rgba(64, 158, 255, 0.3) 100%);
                    border-radius: 10px;
                }

                /* 为Firefox添加现代滚动条 */
                .unified-homework-list {
                    scrollbar-width: thin;
                    scrollbar-color: rgba(64, 158, 255, 0.3) rgba(245, 247, 250, 0.3);
                }

                /* 添加一些微动画 */
                @keyframes fadeInUp {
                    from {
                        opacity: 0;
                        transform: translateY(20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }

                .unified-homework-card {
                    animation: fadeInUp 0.6s cubic-bezier(0.4, 0, 0.2, 1) forwards;
                }

                .unified-homework-card:nth-child(1) { animation-delay: 0.1s; }
                .unified-homework-card:nth-child(2) { animation-delay: 0.15s; }
                .unified-homework-card:nth-child(3) { animation-delay: 0.2s; }
                .unified-homework-card:nth-child(4) { animation-delay: 0.25s; }
                .unified-homework-card:nth-child(5) { animation-delay: 0.3s; }
                .unified-homework-card:nth-child(n+6) { animation-delay: 0.35s; }
            `);
        }

        openAssignmentDetails(assignmentId, title, type) {
            console.log('Opening details:', { assignmentId, title, type });
            
            // 根据类型决定跳转到哪个页面
            let url;
            if (type === 'exercise') {
                // 练习详情页 - 使用正确的URL格式
                url = `https://ucloud.bupt.edu.cn/uclass/course.html#/answer?id=${assignmentId}`;
            } else {
                // 作业详情页
                url = `https://ucloud.bupt.edu.cn/uclass/course.html#/student/assignmentDetails_fullpage?assignmentId=${assignmentId}&assignmentTitle=${encodeURIComponent(title)}`;
            }
            
            console.log('Navigating to:', url);
            
            // 在当前页面跳转，模拟原始行为
            window.location.href = url;
        }

        // ===== 辅助方法实现 =====

        autoSwitchToAssignmentInfoTab() {
            // 等待页面和标签页加载完成
            const switchToAssignmentTab = async () => {
                try {
                    // 等待标签页容器加载
                    await Utils.wait(() => document.querySelector('.details-tabs'), 5000);
                    
                    // 再等待一下确保标签页完全渲染
                    await Utils.sleep(500);
                    
                    // 查找"作业信息"标签
                    const assignmentTab = document.querySelector('#tab-first') || 
                                        document.querySelector('[aria-controls="pane-first"]') ||
                                        document.querySelector('.el-tabs__item:first-child');
                    
                    if (assignmentTab) {
                        console.log('找到作业信息标签，准备点击');
                        
                        // 检查是否已经是激活状态
                        if (!assignmentTab.classList.contains('is-active')) {
                            console.log('点击作业信息标签');
                            assignmentTab.click();
                            
                            // 如果点击没有效果，尝试触发 tab 切换事件
                            setTimeout(() => {
                                const firstPane = document.querySelector('#pane-first');
                                if (firstPane && firstPane.style.display === 'none') {
                                    console.log('尝试手动切换标签页');
                                    // 手动切换标签页显示状态
                                    const allTabs = document.querySelectorAll('.el-tabs__item');
                                    const allPanes = document.querySelectorAll('.el-tab-pane');
                                    
                                    allTabs.forEach(tab => tab.classList.remove('is-active'));
                                    allPanes.forEach(pane => {
                                        pane.style.display = 'none';
                                        pane.setAttribute('aria-hidden', 'true');
                                    });
                                    
                                    assignmentTab.classList.add('is-active');
                                    if (firstPane) {
                                        firstPane.style.display = '';
                                        firstPane.setAttribute('aria-hidden', 'false');
                                    }
                                }
                            }, 200);
                        } else {
                            console.log('作业信息标签已经是激活状态');
                        }
                    } else {
                        console.warn('未找到作业信息标签');
                    }
                } catch (error) {
                    console.error('自动切换到作业信息标签失败:', error);
                }
            };
            
            // 延迟执行，确保页面完全加载
            setTimeout(switchToAssignmentTab, 1000);
        }

        extractFilenameFromPreviewUrl(url) {
            try {
                const match = url.match(/previewUrl=([^&]+)/);
                if (!match) return null;
                const previewUrl = decodeURIComponent(match[1]);
                const filenameMatch = previewUrl.match(/filename%3D([^&]+)/);
                if (!filenameMatch) return null;
                return decodeURIComponent(decodeURIComponent(filenameMatch[1]));
            } catch (e) {
                return null;
            }
        }

        autoClosePreviewPopup() {
            const observer = new MutationObserver(() => {
                const dialogBox = document.querySelector('div.el-message-box__wrapper');
                if (dialogBox && window.getComputedStyle(dialogBox).display !== 'none') {
                    const messageElement = dialogBox.querySelector('.el-message-box__message p');
                    if (messageElement) {
                        const text = messageElement.textContent;
                        if (text.includes('您正在学习其他课件') || text.includes('您已经在学习此课件了')) {
                            const confirmButton = dialogBox.querySelector('.el-button--primary');
                            if (confirmButton) {
                                confirmButton.click();
                            }
                        }
                    }
                }
            });

            observer.observe(document.body, { childList: true, subtree: true });
            this.observers.add(observer);
        }

        insertCourseInfo(courseInfo) {
            const insertCourseInfoElement = () => {
                const titleElement = Utils.$x('/html/body/div[1]/div/div[2]/div[2]/div/div/div[2]/div/div[2]/div[1]/div/div/div[1]/div/p[1]')[0];
                if (!titleElement) {
                    setTimeout(insertCourseInfoElement, 50);
                    return;
                }

                const container = titleElement.parentElement;
                if (container.querySelector('.course-info-badge-detail')) return;

                const courseInfoElement = document.createElement('div');
                courseInfoElement.className = 'course-info-badge-detail';
                courseInfoElement.innerHTML = `
                    <svg width="14" height="14" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" style="vertical-align: -2px; margin-right: 5px; fill: currentColor;">
                        <path d="M802.2 795.8H221.8c-18.5 0-33.6-15-33.6-33.6V261.8c0-18.5 15-33.6 33.6-33.6h580.4c18.5 0 33.6 15 33.6 33.6v500.4c0 18.5-15.1 33.6-33.6-33.6zM255.4 728.6h513.2V295.4H255.4v433.2z"></path>
                        <path d="M864 728.6H160c-18.5 0-33.6-15-33.6-33.6V160c0-18.5 15-33.6 33.6-33.6h580.4c18.5 0 33.6 15 33.6 33.6v50.4h62c18.5 0 33.6 15 33.6 33.6v545c0 18.5-15.1 33.6-33.6 33.6zm-670.4-67.2h603.2V227.2H193.6v434.2zm670.4-134.4H830.4V295.4c0-18.5-15-33.6-33.6-33.6H227.2v-62h502.8v434.4z"></path>
                        <path d="M322.6 626.2h378.8c8.4 0 15.2-6.8 15.2-15.2s-6.8-15.2-15.2-15.2H322.6c-8.4 0-15.2 6.8-15.2 15.2s6.8 15.2 15.2 15.2zM322.6 498.6h378.8c8.4 0 15.2-6.8 15.2-15.2s-6.8-15.2-15.2-15.2H322.6c-8.4 0-15.2 6.8-15.2 15.2s6.8 15.2 15.2 15.2zM322.6 371h378.8c8.4 0 15.2-6.8 15.2-15.2s-6.8-15.2-15.2-15.2H322.6c-8.4 0-15.2 6.8-15.2 15.2s6.8 15.2 15.2 15.2z"></path>
                    </svg>
                    <span>${courseInfo.name}(${courseInfo.teachers})</span>
                `;

                container.insertBefore(courseInfoElement, titleElement);
            };

            insertCourseInfoElement();
        }

        async handleAssignmentResources(assignmentId) {
            try {
                const detail = await API.getAssignmentDetail(assignmentId);
                if (!detail?.data?.assignmentResource) return;

                const resources = detail.data.assignmentResource;
                const filenames = resources.map(x => x.resourceName);
                const previewData = await Promise.all(
                    resources.map(x => API.getPreviewURL(x.resourceId))
                );

                await Utils.wait(() => Utils.$x('//*[@id="assignment-info"]/div[2]/div[2]/div[2]/div').length > 0);

                const elements = Utils.$x('//*[@id="assignment-info"]/div[2]/div[2]/div[2]/div');
                elements.forEach((element, index) => {
                    if (index >= resources.length) return;

                    // 清理现有按钮
                    const existingButtons = element.querySelectorAll('.by-icon-eye-grey, .by-icon-yundown-grey');
                    existingButtons.forEach(btn => btn.remove());

                    const { previewUrl, onlinePreview } = previewData[index];
                    const filename = filenames[index];

                    // 创建预览按钮
                    const previewBtn = document.createElement('i');
                    previewBtn.title = '预览';
                    previewBtn.classList.add('by-icon-eye-grey');
                    previewBtn.addEventListener('click', () => {
                        if (Settings.get('preview', 'autoDownload')) {
                            this.downloadManager.downloadFile(previewUrl, filename);
                        }
                        this.openPreview(previewUrl, filename, onlinePreview);
                    });

                    // 创建下载按钮
                    const downloadBtn = document.createElement('i');
                    downloadBtn.title = '下载';
                    downloadBtn.classList.add('by-icon-yundown-grey');
                    downloadBtn.addEventListener('click', () => {
                        this.downloadManager.downloadFile(previewUrl, filename);
                    });

                    // 插入按钮
                    if (element.children.length >= 3) {
                        element.children[3]?.remove();
                        element.children[2]?.insertAdjacentElement('afterend', previewBtn);
                        element.children[2]?.remove();
                        element.children[1]?.insertAdjacentElement('afterend', downloadBtn);
                    } else {
                        element.appendChild(downloadBtn);
                        element.appendChild(previewBtn);
                    }
                });
            } catch (error) {
                console.error('Handle assignment resources error:', error);
            }
        }

        openPreview(url, filename, onlinePreview) {
            if (Utils.hasFileExtension(filename, CONSTANTS.FILE_EXTENSIONS.office)) {
                Utils.openTab(CONSTANTS.OFFICE_PREVIEW_BASE + encodeURIComponent(url));
            } else if (onlinePreview) {
                Utils.openTab(onlinePreview + encodeURIComponent(url));
            }
        }

        setupHomeworkSourceDisplay(assignments) {
            let lastAssignmentFingerprint = '';
            let lastPageNumber = -1;
            let isUpdating = false;
            let updateTimer = null;

            const getCurrentPage = () => {
                try {
                    const inProgressSection = document.querySelector('.in-progress-section');
                    if (inProgressSection) {
                        const pageIndicator = inProgressSection.querySelector('.banner-indicator');
                        if (pageIndicator) {
                            const pageText = pageIndicator.innerText || pageIndicator.textContent || '';
                            const pageMatch = pageText.match(/^(\d+)\s*\/\s*\d+/);
                            if (pageMatch?.[1]) {
                                return parseInt(pageMatch[1], 10);
                            }
                        }
                    }
                } catch (error) {
                    console.warn('Get current page error:', error);
                }
                return 1;
            };

            const updateHomeworkSources = async (immediate = false) => {
                if (isUpdating && !immediate) return;
                
                // 清除之前的定时器
                if (updateTimer) {
                    clearTimeout(updateTimer);
                    updateTimer = null;
                }

                // 如果不是立即执行，设置短暂延迟以避免频繁调用
                if (!immediate) {
                    updateTimer = setTimeout(() => updateHomeworkSources(true), 100);
                    return;
                }

                isUpdating = true;

                try {
                    const assignmentItems = document.querySelectorAll(CONSTANTS.SELECTORS.homeworkItems);
                    if (!assignmentItems.length) {
                        isUpdating = false;
                        return;
                    }

                    const currentPage = getCurrentPage();
                    const assignmentTitles = Array.from(assignmentItems)
                        .map(item => item.querySelector('.activity-title')?.innerText?.trim().substring(0, 20) || '')
                        .join('|');

                    const contentChanged = assignmentTitles !== lastAssignmentFingerprint;
                    const pageChanged = currentPage !== lastPageNumber;

                    if (contentChanged || pageChanged) {
                        lastAssignmentFingerprint = assignmentTitles;
                        lastPageNumber = currentPage;
                        await this.updateAssignmentDisplay(assignments, currentPage);
                    }
                } catch (error) {
                    console.error('Update homework sources error:', error);
                } finally {
                    isUpdating = false;
                }
            };

            // 初始更新
            setTimeout(() => updateHomeworkSources(true), 300);

            // 使用更短的轮询间隔作为兜底
            const pollingInterval = setInterval(() => updateHomeworkSources(), 200);

            // 监听翻页按钮点击
            const handlePageNavigation = (event) => {
                const target = event.target;
                if (target?.classList.contains('el-icon-arrow-left') || 
                    target?.closest('.el-icon-arrow-left') ||
                    target?.classList.contains('el-icon-arrow-right') || 
                    target?.closest('.el-icon-arrow-right') ||
                    target?.closest('.el-pagination') ||
                    target?.closest('.banner-indicator')) {
                    // 立即触发更新
                    setTimeout(() => updateHomeworkSources(true), 50);
                    // 再次确保更新
                    setTimeout(() => updateHomeworkSources(true), 200);
                }
            };

            document.addEventListener('click', handlePageNavigation, true);

            // 使用 MutationObserver 监听DOM变化
            const observer = new MutationObserver(Utils.throttle(() => {
                updateHomeworkSources();
            }, 100));

            // 监听作业列表容器的变化
            const homeworkContainer = document.querySelector('.in-progress-section .in-progress-body');
            if (homeworkContainer) {
                observer.observe(homeworkContainer, {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['class', 'style']
                });
            }

            // 监听分页指示器的变化
            const pageIndicator = document.querySelector('.in-progress-section .banner-indicator');
            if (pageIndicator) {
                observer.observe(pageIndicator, {
                    childList: true,
                    subtree: true,
                    characterData: true
                });
            }

            // 键盘导航支持
            document.addEventListener('keydown', (event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    setTimeout(() => updateHomeworkSources(true), 100);
                }
            });

            // 清理资源
            const cleanup = () => {
                clearInterval(pollingInterval);
                if (updateTimer) clearTimeout(updateTimer);
                observer.disconnect();
                document.removeEventListener('click', handlePageNavigation, true);
            };

            window.addEventListener('beforeunload', cleanup);
            
            // 存储清理函数以便后续调用
            this.homeworkSourceCleanup = cleanup;
        }

        async updateAssignmentDisplay(assignments, page) {
            if (!assignments?.length) return;

            try {
                const startIdx = (page - 1) * 6;
                const endIdx = page * 6;
                const pageAssignments = assignments.slice(startIdx, endIdx);
                
                if (!pageAssignments.length) return;

                const taskIds = pageAssignments.map(x => x.activityId);
                const courseInfos = await API.searchCourses(taskIds);

                const courseTexts = pageAssignments.map(assignment => {
                    const info = courseInfos[assignment.activityId];
                    return info ? `${info.name}(${info.teachers})` : '加载中...';
                });

                let retryCount = 0;
                let nodes;

                while (retryCount < CONSTANTS.RETRY_ATTEMPTS) {
                    await Utils.sleep(300 * (retryCount + 1));
                    nodes = document.querySelectorAll(CONSTANTS.SELECTORS.homeworkItems);
                    if (nodes.length > 0) break;
                    retryCount++;
                }

                if (!nodes?.length) return;

                nodes.forEach((node, index) => {
                    if (index >= courseTexts.length) return;

                    const titleElement = node.querySelector('.activity-title');
                    if (!titleElement) return;

                    // 移除旧的课程信息
                    const oldInfoElement = node.querySelector('.course-info-badge');
                    if (oldInfoElement) {
                        oldInfoElement.remove();
                    }

                    // 创建新的课程信息元素
                    const courseInfoElement = document.createElement('div');
                    courseInfoElement.className = 'course-info-badge';
                    courseInfoElement.innerHTML = `
                        <svg width="12" height="12" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" style="vertical-align: -2px; margin-right: 4px; fill: currentColor;">
                            <path d="M802.2 795.8H221.8c-18.5 0-33.6-15-33.6-33.6V261.8c0-18.5 15-33.6 33.6-33.6h580.4c18.5 0 33.6 15 33.6 33.6v500.4c0 18.5-15.1 33.6-33.6-33.6zM255.4 728.6h513.2V295.4H255.4v433.2z"></path>
                            <path d="M864 728.6H160c-18.5 0-33.6-15-33.6-33.6V160c0-18.5 15-33.6 33.6-33.6h580.4c18.5 0 33.6 15 33.6 33.6v50.4h62c18.5 0 33.6 15 33.6 33.6v545c0 18.5-15.1 33.6-33.6 33.6zm-670.4-67.2h603.2V227.2H193.6v434.2zm670.4-134.4H830.4V295.4c0-18.5-15-33.6-33.6-33.6H227.2v-62h502.8v434.4z"></path>
                            <path d="M322.6 626.2h378.8c8.4 0 15.2-6.8 15.2-15.2s-6.8-15.2-15.2-15.2H322.6c-8.4 0-15.2 6.8-15.2 15.2s6.8 15.2 15.2 15.2zM322.6 498.6h378.8c8.4 0 15.2-6.8 15.2-15.2s-6.8-15.2-15.2-15.2H322.6c-8.4 0-15.2 6.8-15.2 15.2s6.8 15.2 15.2 15.2zM322.6 371h378.8c8.4 0 15.2-6.8 15.2-15.2s-6.8-15.2-15.2-15.2H322.6c-8.4 0-15.2 6.8-15.2 15.2s6.8 15.2 15.2 15.2z"></path>
                        </svg>
                        <span>${courseTexts[index]}</span>
                    `;

                    const container = titleElement.parentElement;
                    if (container) {
                        container.style.setProperty('flex-direction', 'column', 'important');
                        container.style.setProperty('justify-content', 'center', 'important');
                        container.insertBefore(courseInfoElement, titleElement);
                    }
                });
            } catch (error) {
                console.error('Update assignment display error:', error);
            }
        }

        async setupCourseResources(resources) {
            if (!resources.length) return;

            const resourceItems = Utils.$x(CONSTANTS.SELECTORS.resourceItems);
            const previewItems = Utils.$x(CONSTANTS.SELECTORS.previewItems);

            if (!resourceItems.length) return;

            // 为每个资源添加功能
            resourceItems.forEach(async (element, index) => {
                if (index >= resources.length) return;

                const resource = resources[index];

                // 自动下载功能
                if (Settings.get('preview', 'autoDownload') && previewItems[index]) {
                    previewItems[index].addEventListener('click', async () => {
                        try {
                            const { previewUrl } = await API.getPreviewURL(resource.id);
                            this.downloadManager.downloadFile(previewUrl, resource.name);
                        } catch (error) {
                            console.error('Auto download error:', error);
                        }
                    }, false);
                }

                // 显示所有下载按钮
                if (Settings.get('course', 'showAllDownloadButoon')) {
                    this.addDownloadButton(element, resource, index);
                }
            });

            // 批量下载按钮
            if (Settings.get('course', 'addBatchDownload')) {
                this.addBatchDownloadButton(resources);
            }
        }

        addDownloadButton(container, resource, index) {
            const downloadBtn = document.createElement('i');
            downloadBtn.title = '下载';
            downloadBtn.classList.add('by-icon-download', 'btn-icon', 'visible');
            downloadBtn.style.cssText = `
                display: inline-block !important;
                visibility: visible !important;
                cursor: pointer !important;
            `;

            // 获取data-v属性
            const dataAttr = Array.from(container.attributes).find(attr => 
                attr.localName.startsWith('data-v')
            );
            if (dataAttr) {
                downloadBtn.setAttribute(dataAttr.localName, '');
            }

            downloadBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    const { previewUrl } = await API.getPreviewURL(resource.id);
                    this.downloadManager.downloadFile(previewUrl, resource.name);
                } catch (error) {
                    console.error('Download error:', error);
                    NotificationManager.show('下载失败', error.message, 'error');
                }
            }, false);

            if (container.children.length) {
                container.children[0].remove();
            }
            container.insertAdjacentElement('afterbegin', downloadBtn);
        }

        addBatchDownloadButton(resources) {
            if (document.getElementById('downloadAllButton')) return;

            const buttonHtml = `
                <div style="display: flex; flex-direction: row; justify-content: end; margin-right: 24px; margin-top: 20px;">
                    <button type="button" class="el-button submit-btn el-button--primary" id="downloadAllButton">
                        下载全部
                    </button>
                </div>
            `;

            const resourceList = Utils.$x('/html/body/div/div/div[2]/div[2]/div/div/div');
            if (!resourceList.length) return;

            const containerElement = document.createElement('div');
            containerElement.innerHTML = buttonHtml;
            resourceList[0].before(containerElement);

            const button = document.getElementById('downloadAllButton');
            button.onclick = async () => {
                if (this.downloadManager.downloading) {
                    this.downloadManager.cancel();
                    button.textContent = '下载全部';
                    return;
                }

                button.textContent = '取消下载';
                
                try {
                    for (const resource of resources) {
                        if (!this.downloadManager.downloading) break;
                        
                        const { previewUrl } = await API.getPreviewURL(resource.id);
                        await this.downloadManager.downloadFile(previewUrl, resource.name);
                    }
                } catch (error) {
                    console.error('Batch download error:', error);
                    NotificationManager.show('批量下载失败', error.message, 'error');
                } finally {
                    button.textContent = '下载全部';
                }
            };
        }

        processNotifications() {
            const processNotificationsInternal = () => {
                const noticeContainer = document.querySelector(CONSTANTS.SELECTORS.notificationContainer);
                if (!noticeContainer) return;

                const noticeItems = Array.from(noticeContainer.querySelectorAll('li'));
                if (!noticeItems.length) return;

                // 按时间排序
                if (Settings.get('notification', 'sortNotificationsByTime')) {
                    noticeItems.sort((a, b) => {
                        const timeA = a.querySelector('span._left-time');
                        const timeB = b.querySelector('span._left-time');
                        if (!timeA || !timeB) return 0;

                        const dateA = new Date(timeA.textContent.trim());
                        const dateB = new Date(timeB.textContent.trim());
                        return dateB - dateA;
                    });
                }

                // 更新高亮
                noticeItems.forEach(item => {
                    if (Settings.get('notification', 'betterNotificationHighlight')) {
                        const hasRedDot = item.querySelector('div.el-badge sup.el-badge__content.is-dot');
                        item.classList.toggle('notification-with-dot', !!hasRedDot);
                    }
                    noticeContainer.appendChild(item);
                });
            };

            // 等待加载完成
            const loadingMaskSelector = '#layout-container > div.main-content > div.router-container > div > div > div.setNotice-body > div.el-loading-mask';
            const observer = new MutationObserver(() => {
                const loadingMask = document.querySelector(loadingMaskSelector);
                if (loadingMask?.style.display === 'none') {
                    processNotificationsInternal();
                    observer.disconnect();
                }
            });

            const loadingMask = document.querySelector(loadingMaskSelector);
            if (loadingMask?.style.display === 'none') {
                processNotificationsInternal();
            } else {
                observer.observe(document.body, {
                    attributes: true,
                    attributeFilter: ['style'],
                    subtree: true
                });
                setTimeout(() => observer.disconnect(), 10000);
            }
        }

        createImageViewer(imageUrl) {
            // 简化的图片查看器实现
            const viewer = document.createElement('div');
            viewer.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0,0,0,0.9);
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
            `;

            const img = document.createElement('img');
            img.src = imageUrl;
            img.style.cssText = `
                max-width: 90%;
                max-height: 90%;
                object-fit: contain;
            `;

            viewer.appendChild(img);
            document.body.appendChild(viewer);

            viewer.addEventListener('click', () => {
                document.body.removeChild(viewer);
            });

            // ESC键关闭
            const handleKeyPress = (e) => {
                if (e.key === 'Escape') {
                    document.body.removeChild(viewer);
                    document.removeEventListener('keydown', handleKeyPress);
                }
            };
            document.addEventListener('keydown', handleKeyPress);
        }

        createUI() {
            if (!Settings.get('system', 'showConfigButton')) return;

            // 添加设置界面样式
            GM_addStyle(`
                #yzHelper-settings {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    background: #fff;
                    box-shadow: 0 4px 16px rgba(0,0,0,0.08);
                    border-radius: 12px;
                    z-index: 9999;
                    width: 500px;
                    height: 450px;
                    font-family: 'Segoe UI', 'Microsoft YaHei', sans-serif;
                    transition: all 0.3s ease;
                    opacity: 0;
                    transform: translateY(10px);
                    color: #333;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    display: none;
                }
                #yzHelper-settings.visible {
                    opacity: 1;
                    transform: translateY(0);
                }

                #yzHelper-header {
                    padding: 15px 20px;
                    border-bottom: 1px solid #ebeef5;
                    background: #fff;
                    color: #303133;
                    font-weight: bold;
                    font-size: 16px;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    box-shadow: none;
                }

                #yzHelper-main {
                    display: flex;
                    flex: 1;
                    overflow: hidden;
                }

                #yzHelper-settings-sidebar {
                    width: 140px;
                    background: #f5f7fa;
                    padding: 15px 0;
                    border-right: 1px solid #ebeef5;
                    overflow-y: auto;
                    overflow-x: hidden;
                }

                #yzHelper-settings-sidebar .menu-item {
                    padding: 12px 15px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    font-size: 14px;
                    color: #606266;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    border-radius: 6px 0 0 6px;
                    margin: 2px 0;
                }

                #yzHelper-settings-sidebar .menu-item:hover {
                    background: #e3f0fd;
                    color: #409EFF;
                    transform: none;
                }

                #yzHelper-settings-sidebar .menu-item.active {
                    background: #409EFF;
                    color: #fff;
                    font-weight: 500;
                    box-shadow: none;
                }

                #yzHelper-settings-sidebar .emoji {
                    font-size: 16px;
                }

                #yzHelper-settings-content {
                    flex: 1;
                    padding: 20px;
                    overflow-y: auto;
                    position: relative;
                    padding-bottom: 70px;
                    background: #fff;
                }

                #yzHelper-settings-content .settings-section {
                    display: none;
                }

                #yzHelper-settings-content .settings-section.active {
                    display: block;
                }

                #yzHelper-settings h3 {
                    margin-top: 0;
                    margin-bottom: 15px;
                    font-size: 18px;
                    font-weight: 600;
                    color: #303133;
                    padding-bottom: 10px;
                    border-bottom: 1px solid #ebeef5;
                }
                #yzHelper-settings .setting-item {
                    margin-bottom: 16px;
                }
                #yzHelper-settings .setting-toggle {
                    display: flex;
                    align-items: center;
                }
                #yzHelper-settings .setting-item:last-of-type {
                    margin-bottom: 20px;
                }
                #yzHelper-settings .switch {
                    position: relative;
                    display: inline-block;
                    width: 44px;
                    height: 24px;
                    margin-right: 10px;
                }
                #yzHelper-settings .switch input {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }
                #yzHelper-settings .slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: #dcdfe6;
                    transition: .3s;
                    border-radius: 24px;
                }
                #yzHelper-settings .slider:before {
                    position: absolute;
                    content: "";
                    height: 18px;
                    width: 18px;
                    left: 3px;
                    bottom: 3px;
                    background-color: white;
                    transition: .3s;
                    border-radius: 50%;
                }
                #yzHelper-settings input:checked + .slider {
                    background: #409EFF;
                    box-shadow: none;
                }
                #yzHelper-settings input:focus + .slider {
                    box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15);
                }
                #yzHelper-settings input:checked + .slider:before {
                    transform: translateX(20px);
                }
                #yzHelper-settings .setting-label {
                    font-size: 14px;
                    cursor: pointer;
                }

                #yzHelper-settings .setting-description {
                    display: block;
                    margin-left: 54px;
                    font-size: 12px;
                    color: #666;
                    background: #f5f7fa;
                    border-left: 3px solid #409EFF;
                    border-radius: 0 4px 4px 0;
                    max-height: 0;
                    overflow: hidden;
                    opacity: 0;
                    transition: all 0.3s ease;
                    padding: 0 12px;
                    box-shadow: none;
                }

                #yzHelper-settings .setting-description.visible {
                    max-height: 100px;
                    opacity: 1;
                    margin-top: 8px;
                    padding: 8px 12px;
                }

                #yzHelper-settings .buttons {
                    display: flex;
                    justify-content: flex-end;
                    gap: 10px;
                    position: absolute;
                    bottom: 0px;
                    right: 0px;
                    background: #fff;
                    padding: 10px 20px;
                    width: calc(100% - 40px);
                    border-top: 1px solid #ebeef5;
                    box-sizing: border-box;
                }
                #yzHelper-settings button {
                    background: #409EFF;
                    border: none;
                    padding: 8px 16px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-weight: 500;
                    color: #fff;
                    transition: all 0.2s ease;
                    outline: none;
                    font-size: 14px;
                    box-shadow: none;
                }
                #yzHelper-settings button:hover {
                    background: #3076c9;
                    transform: none;
                    box-shadow: none;
                }
                #yzHelper-settings button.cancel {
                    background: #f5f7fa;
                    color: #606266;
                    box-shadow: none;
                }
                #yzHelper-settings button.cancel:hover {
                    background: #e4e7ed;
                    transform: none;
                    box-shadow: none;
                }

                #yzHelper-settings-toggle {
                    position: fixed;
                    bottom: 20px;
                    right: 20px;
                    background: #409EFF;
                    color: #fff;
                    width: 50px;
                    height: 50px;
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 24px;
                    cursor: pointer;
                    z-index: 9998;
                    box-shadow: 0 4px 12px rgba(64, 158, 255, 0.15);
                    transition: all 0.3s ease;
                }
                #yzHelper-settings-toggle:hover {
                    background: #3076c9;
                    transform: scale(1.05);
                    box-shadow: 0 6px 20px rgba(64, 158, 255, 0.18);
                }

                #yzHelper-settings input[type="text"],
                #yzHelper-settings input[type="password"],
                #yzHelper-settings input[type="email"] {
                    width: 100%;
                    padding: 10px 15px;
                    border: 1px solid #dcdfe6;
                    border-radius: 4px;
                    font-size: 14px;
                    color: #606266;
                    box-sizing: border-box;
                    transition: all 0.3s;
                    outline: none;
                    background: #fff;
                }
                #yzHelper-settings input[type="text"]:focus,
                #yzHelper-settings input[type="password"]:focus,
                #yzHelper-settings input[type="email"]:focus {
                    border-color: #409EFF;
                    box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.12);
                }
            `);

            // 创建设置按钮
            const settingsToggle = document.createElement("div");
            settingsToggle.id = "yzHelper-settings-toggle";
            settingsToggle.innerHTML = "⚙️";
            settingsToggle.title = "云邮助手设置";
            document.body.appendChild(settingsToggle);

            // 创建设置面板
            const settingsPanel = document.createElement("div");
            settingsPanel.id = "yzHelper-settings";

            const header = `
                <div id="yzHelper-header">
                    <span>云邮教学空间助手</span>
                    <span id="yzHelper-version">v0.32</span>
                </div>
            `;

            const mainContent = `
                <div id="yzHelper-main">
                    <div id="yzHelper-settings-sidebar">
                        <div class="menu-item active" data-section="home">
                            <span class="emoji">👤</span>
                            <span>个人主页</span>
                        </div>
                        <div class="menu-item" data-section="preview">
                            <span class="emoji">🖼️</span>
                            <span>课件预览</span>
                        </div>
                        <div class="menu-item" data-section="course">
                            <span class="emoji">📚</span>
                            <span>课程详情</span>
                        </div>
                        <div class="menu-item" data-section="homework">
                            <span class="emoji">📝</span>
                            <span>作业详情</span>
                        </div>
                        <div class="menu-item" data-section="notification">
                            <span class="emoji">📢</span>
                            <span>消息通知</span>
                        </div>
                        <div class="menu-item" data-section="system">
                            <span class="emoji">⚙️</span>
                            <span>系统设置</span>
                        </div>
                    </div>

                    <div id="yzHelper-settings-content">
                        <!-- 个人主页设置 -->
                        <div class="settings-section active" id="section-home">
                            <h3>👤 个人主页设置</h3>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="home_addHomeworkSource" ${Settings.get('home', 'addHomeworkSource') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-home_addHomeworkSource">统一作业视图</span>
                                </div>
                                <div class="setting-description" id="description-home_addHomeworkSource">
                                    将所有待办作业在一个界面中统一显示，包含课程来源、截止时间、紧急程度等信息，无需翻页查看。支持快速跳转到作业详情页面。
                                </div>
                            </div>
                        </div>

                        <!-- 课件预览设置 -->
                        <div class="settings-section" id="section-preview">
                            <h3>🖼️ 课件预览设置</h3>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="preview_autoDownload" ${Settings.get('preview', 'autoDownload') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-preview_autoDownload">预览课件时自动下载</span>
                                </div>
                                <div class="setting-description" id="description-preview_autoDownload">
                                    当打开课件预览时，自动触发下载操作，方便存储课件到本地。
                                </div>
                            </div>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="preview_autoSwitchOffice" ${Settings.get('preview', 'autoSwitchOffice') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-preview_autoSwitchOffice">使用 Office365 预览 Office 文件</span>
                                </div>
                                <div class="setting-description" id="description-preview_autoSwitchOffice">
                                    使用微软 Office365 在线服务预览 Office 文档，提供更好的浏览体验。
                                </div>
                            </div>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="preview_autoSwitchPdf" ${Settings.get('preview', 'autoSwitchPdf') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-preview_autoSwitchPdf">使用浏览器原生阅读器预览PDF文件</span>
                                </div>
                                <div class="setting-description" id="description-preview_autoSwitchPdf">
                                    使用系统（浏览器）原生的阅读器预览PDF文档，提供更好的浏览体验。
                                </div>
                            </div>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="preview_autoSwitchImg" ${Settings.get('preview', 'autoSwitchImg') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-preview_autoSwitchImg">使用脚本内置阅读器预览图片文件</span>
                                </div>
                                <div class="setting-description" id="description-preview_autoSwitchImg">
                                    使用脚本内置的阅读器预览图片文件，提供更好的浏览体验。
                                </div>
                            </div>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="preview_autoClosePopup" ${Settings.get('preview', 'autoClosePopup') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-preview_autoClosePopup">自动关闭弹窗</span>
                                </div>
                                <div class="setting-description" id="description-preview_autoClosePopup">
                                    自动关闭预览时出现的"您已经在学习"及同类弹窗。
                                </div>
                            </div>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="preview_hideTimer" ${Settings.get('preview', 'hideTimer') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-preview_hideTimer">隐藏预览界面倒计时</span>
                                </div>
                                <div class="setting-description" id="description-preview_hideTimer">
                                    隐藏预览界面中的倒计时提示，获得无干扰的阅读体验。
                                </div>
                            </div>
                        </div>

                        <!-- 课程详情设置 -->
                        <div class="settings-section" id="section-course">
                            <h3>📚 课程详情设置</h3>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="course_addBatchDownload" ${Settings.get('course', 'addBatchDownload') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-course_addBatchDownload">增加批量下载按钮</span>
                                </div>
                                <div class="setting-description" id="description-course_addBatchDownload">
                                    增加批量下载按钮，方便一键下载课程中的所有课件。
                                </div>
                            </div>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="course_showAllDownloadButoon" ${Settings.get('course', 'showAllDownloadButoon') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-course_showAllDownloadButoon">显示所有下载按钮</span>
                                </div>
                                <div class="setting-description" id="description-course_showAllDownloadButoon">
                                    使每个课件文件都有下载按钮，不允许下载的课件在启用后也可以下载。
                                </div>
                            </div>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="course_showAllCourses" ${Settings.get('course', 'showAllCourses') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-course_showAllCourses">课程列表显示</span>
                                </div>
                                <div class="setting-description" id="description-course_showAllCourses">
                                    将本学期所有课程在一个界面中统一展示，提供搜索功能，无需翻页查看全部课程。
                                </div>
                            </div>
                        </div>

                        <!-- 作业详情设置 -->
                        <div class="settings-section" id="section-homework">
                            <h3>📝 作业详情设置</h3>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="homework_showHomeworkSource" ${Settings.get('homework', 'showHomeworkSource') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-homework_showHomeworkSource">显示作业所属课程</span>
                                </div>
                                <div class="setting-description" id="description-homework_showHomeworkSource">
                                    在作业详情页显示作业所属的课程名称，便于区分不同课程的作业。
                                </div>
                            </div>
                        </div>

                        <!-- 消息通知设置 -->
                        <div class="settings-section" id="section-notification">
                            <h3>📢 消息通知设置</h3>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="notification_showMoreNotification" ${Settings.get('notification', 'showMoreNotification') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-notification_showMoreNotification">显示更多的通知</span>
                                </div>
                                <div class="setting-description" id="description-notification_showMoreNotification">
                                    在通知列表中显示更多的历史通知，不再受限于默认显示数量。
                                </div>
                            </div>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="notification_sortNotificationsByTime" ${Settings.get('notification', 'sortNotificationsByTime') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-notification_sortNotificationsByTime">通知按照时间排序</span>
                                </div>
                                <div class="setting-description" id="description-notification_sortNotificationsByTime">
                                    将通知按照时间先后顺序排列，更容易找到最新或最早的通知。
                                </div>
                            </div>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="notification_betterNotificationHighlight" ${Settings.get('notification', 'betterNotificationHighlight') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-notification_betterNotificationHighlight">优化未读通知高亮</span>
                                </div>
                                <div class="setting-description" id="description-notification_betterNotificationHighlight">
                                    增强未读通知的视觉提示，使未读消息更加醒目，不易遗漏重要信息。
                                </div>
                            </div>
                        </div>

                        <!-- 系统设置 -->
                        <div class="settings-section" id="section-system">
                            <h3>⚙️ 系统设置</h3>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="system_betterTitle" ${Settings.get('system', 'betterTitle') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-system_betterTitle">优化页面标题</span>
                                </div>
                                <div class="setting-description" id="description-system_betterTitle">
                                    优化浏览器标签页的标题显示，更直观地反映当前页面内容。
                                </div>
                            </div>
                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="system_unlockCopy" ${Settings.get('system', 'unlockCopy') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-system_unlockCopy">解除复制限制</span>
                                </div>
                                <div class="setting-description" id="description-system_unlockCopy">
                                    解除全局的复制限制，方便摘录内容进行学习笔记。
                                </div>
                            </div>

                            <div class="setting-item">
                                <div class="setting-toggle">
                                    <label class="switch">
                                        <input type="checkbox" id="system_showConfigButton" ${Settings.get('system', 'showConfigButton') ? 'checked' : ''}>
                                        <span class="slider"></span>
                                    </label>
                                    <span class="setting-label" data-for="description-system_showConfigButton">显示插件悬浮窗</span>
                                </div>
                                <div class="setting-description" id="description-system_showConfigButton">
                                    在网页界面显示助手配置按钮，方便随时调整设置。
                                </div>
                            </div>
                        </div>

                        <div class="buttons">
                            <button id="cancelSettings" class="cancel">取消</button>
                            <button id="saveSettings">保存设置</button>
                        </div>
                    </div>
                </div>
            `;

            settingsPanel.innerHTML = header + mainContent;
            document.body.appendChild(settingsPanel);

            // 事件处理
            this.setupSettingsEvents(settingsToggle, settingsPanel);
        }

        setupSettingsEvents(settingsToggle, settingsPanel) {
            // 菜单切换功能
            document.querySelectorAll("#yzHelper-settings-sidebar .menu-item").forEach((item) => {
                item.addEventListener("click", function () {
                    document.querySelectorAll("#yzHelper-settings-sidebar .menu-item").forEach((i) => {
                        i.classList.remove("active");
                    });
                    document.querySelectorAll("#yzHelper-settings-content .settings-section").forEach((section) => {
                        section.classList.remove("active");
                    });

                    this.classList.add("active");
                    const sectionId = "section-" + this.getAttribute("data-section");
                    document.getElementById(sectionId).classList.add("active");

                    document.querySelectorAll(".setting-description").forEach((desc) => {
                        desc.classList.remove("visible");
                    });
                });
            });

            // 设置描述显示/隐藏功能
            document.querySelectorAll(".setting-label").forEach((label) => {
                label.addEventListener("click", function () {
                    const descriptionId = this.getAttribute("data-for");
                    const description = document.getElementById(descriptionId);

                    document.querySelectorAll(".setting-description").forEach((desc) => {
                        if (desc.id !== descriptionId) {
                            desc.classList.remove("visible");
                        }
                    });

                    description.classList.toggle("visible");
                });
            });

            const settingsTrigger = () => {
                const isVisible = settingsPanel.classList.contains("visible");
                if (isVisible) {
                    settingsPanel.classList.remove("visible");
                    setTimeout(() => {
                        settingsPanel.style.display = "none";
                    }, 300);
                } else {
                    settingsPanel.style.display = "flex";
                    void settingsPanel.offsetWidth;
                    settingsPanel.classList.add("visible");
                }
            };

            settingsToggle.addEventListener("click", settingsTrigger);

            document.getElementById("cancelSettings").addEventListener("click", () => {
                settingsPanel.classList.remove("visible");
                setTimeout(() => {
                    settingsPanel.style.display = "none";
                }, 300);
            });

            document.getElementById("saveSettings").addEventListener("click", () => {
                Array.from(document.querySelector("#yzHelper-settings-content").querySelectorAll('input[type="checkbox"]')).forEach((checkbox) => {
                    const checkboxId = checkbox.id;
                    if (checkboxId.includes("_")) {
                        const [category, settingName] = checkboxId.split("_");
                        if (Settings.defaults[category] && settingName) {
                            Settings.set(category, settingName, checkbox.checked);
                        }
                    }
                });
                settingsPanel.classList.remove("visible");
                setTimeout(() => {
                    settingsPanel.style.display = "none";
                    NotificationManager.show("设置已保存", "刷新页面后生效");
                }, 300);
            });
        }

        registerMenuCommands() {
            GM_registerMenuCommand('显示/隐藏插件悬浮窗', () => {
                const current = Settings.get('system', 'showConfigButton');
                Settings.set('system', 'showConfigButton', !current);
                NotificationManager.show('设置已更新', '页面刷新后生效');
            });
        }

        destroy() {
            // 清理观察器
            this.observers.forEach(observer => observer.disconnect());
            this.observers.clear();
            
            // 清理作业来源显示相关资源
            if (this.homeworkSourceCleanup) {
                this.homeworkSourceCleanup();
            }
        }

        async handleCoursesPage() {
            if (Settings.get('system', 'betterTitle')) {
                document.title = '我的课程 - 教学云空间';
            }

            // 检查是否开启显示所有课程功能
            if (!Settings.get('course', 'showAllCourses')) {
                return;
            }

            // 等待页面完全加载，使用更长的超时时间和更严格的检测
            let lessonSection = null;
            try {
                // 先尝试等待.my-lesson-section加载
                lessonSection = await Utils.wait(() => document.querySelector('.my-lesson-section'), 8000);
                
                // 再等待轮播项加载
                const carouselItems = await Utils.wait(() => {
                    const items = document.querySelectorAll('.el-carousel__item .my-lesson-group');
                    return items && items.length > 0 ? items : null;
                }, 8000);
            } catch (e) {
                console.error('等待页面元素超时:', e);
                NotificationManager.show('加载超时', '无法找到课程元素，请刷新页面重试', 'error');
                return;
            }

            // 额外等待时间确保动态内容加载完毕
            await Utils.sleep(1000);

            try {
                // 提取并显示所有课程
                const success = await this.courseExtractor.extractCourses();
                if (success) {
                    const displaySuccess = this.courseExtractor.displayCourses();
                    
                    if (displaySuccess) {
                        // 隐藏原始容器
                        this.courseExtractor.toggleOriginalContainer(false);
                    } else {
                        console.error('课程显示失败');
                    }
                } else {
                    NotificationManager.show('正在加载', '首次提取失败，5秒后自动重试...', 'info');
                    
                    setTimeout(async () => {
                        const retrySuccess = await this.courseExtractor.extractCourses();
                        if (retrySuccess) {
                            const displaySuccess = this.courseExtractor.displayCourses();
                            if (displaySuccess) {
                                this.courseExtractor.toggleOriginalContainer(false);
                            }
                        } else {
                            console.error('多次尝试后仍无法提取课程');
                            NotificationManager.show('提取失败', '无法提取课程列表，请刷新页面重试', 'error');
                        }
                    }, 5000);
                }
            } catch (error) {
                console.error('处理课程页面时出错:', error);
                NotificationManager.show('发生错误', '处理课程页面时出错: ' + error.message, 'error');
            }
        }
    }

    // ===== 初始化 =====
    if (location.href.startsWith('https://ucloud.bupt.edu.cn/')) {
        // 处理ticket跳转
        if (new URLSearchParams(location.search).get('ticket')?.length) {
            setTimeout(() => {
                location.href = CONSTANTS.URLS.home;
            }, 500);
            return;
        }

        // 等待DOM加载
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => new UCloudEnhancer().init());
        } else {
            new UCloudEnhancer().init();
        }
    }
})();
