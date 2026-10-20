export interface SchoolLesson {
  id: string;
  day: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat';
  lessonNumber: number;
  timeStart: string;
  timeEnd: string;
  subject: string;
  category: string;
  room: string;
  note?: string;
  teacher?: string;
  homework?: string;
  isHomeworkDone?: boolean;
}

export interface DaySchedule {
  dayId: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat';
  dayName: string;
  lessons: {
    num: number;
    time: string;
    subject: string;
    room: string;
    note?: string;
  }[];
}

export const SCHOOL_BELLS = [
  { lessonNumber: 1, timeStart: '08:30', timeEnd: '09:10', breakAfterMinutes: 10 },
  { lessonNumber: 2, timeStart: '09:20', timeEnd: '10:00', breakAfterMinutes: 20 },
  { lessonNumber: 3, timeStart: '10:20', timeEnd: '11:00', breakAfterMinutes: 20 },
  { lessonNumber: 4, timeStart: '11:20', timeEnd: '12:00', breakAfterMinutes: 20 },
  { lessonNumber: 5, timeStart: '12:20', timeEnd: '13:00', breakAfterMinutes: 10 },
  { lessonNumber: 6, timeStart: '13:10', timeEnd: '13:50', breakAfterMinutes: 15 },
  { lessonNumber: 7, timeStart: '14:05', timeEnd: '14:45', breakAfterMinutes: 0 },
];

export const SCHOOL_SCHEDULE_11B: SchoolLesson[] = [
  // Понедельник
  { id: 'sch-mon-1', day: 'Mon', lessonNumber: 1, timeStart: '08:30', timeEnd: '09:10', subject: 'Разговор о важном', category: 'SOC', room: 'каб. 53', homework: '', isHomeworkDone: false },
  { id: 'sch-mon-2', day: 'Mon', lessonNumber: 2, timeStart: '09:20', timeEnd: '10:00', subject: 'Физика', category: 'PHYS', room: 'каб. 51', homework: '', isHomeworkDone: false },
  { id: 'sch-mon-3', day: 'Mon', lessonNumber: 3, timeStart: '10:20', timeEnd: '11:00', subject: 'Объектно-ориентированное программирование', category: 'INF', room: 'каб. 57 / 74', note: '1 / 2 подгруппа', homework: '', isHomeworkDone: false },
  { id: 'sch-mon-4', day: 'Mon', lessonNumber: 4, timeStart: '11:20', timeEnd: '12:00', subject: 'Объектно-ориентированное программирование', category: 'INF', room: 'каб. 57 / 74', note: '1 / 2 подгруппа', homework: '', isHomeworkDone: false },
  { id: 'sch-mon-5', day: 'Mon', lessonNumber: 5, timeStart: '12:20', timeEnd: '13:00', subject: 'Алгебра', category: 'MATH_EGE', room: 'каб. 62', homework: '', isHomeworkDone: false },
  { id: 'sch-mon-6', day: 'Mon', lessonNumber: 6, timeStart: '13:10', timeEnd: '13:50', subject: 'Алгебра', category: 'MATH_EGE', room: 'каб. 62', homework: '', isHomeworkDone: false },
  { id: 'sch-mon-7', day: 'Mon', lessonNumber: 7, timeStart: '14:05', timeEnd: '14:45', subject: 'Физическая культура', category: 'PE', room: 'каб. 20', homework: '', isHomeworkDone: false },

  // Вторник
  { id: 'sch-tue-1', day: 'Tue', lessonNumber: 1, timeStart: '08:30', timeEnd: '09:10', subject: 'Литература', category: 'LIT', room: 'каб. 65', homework: '', isHomeworkDone: false },
  { id: 'sch-tue-2', day: 'Tue', lessonNumber: 2, timeStart: '09:20', timeEnd: '10:00', subject: 'Физика', category: 'PHYS', room: 'каб. 51', homework: '', isHomeworkDone: false },
  { id: 'sch-tue-3', day: 'Tue', lessonNumber: 3, timeStart: '10:20', timeEnd: '11:00', subject: 'Химия', category: 'CHEM', room: 'каб. 68', homework: '', isHomeworkDone: false },
  { id: 'sch-tue-4', day: 'Tue', lessonNumber: 4, timeStart: '11:20', timeEnd: '12:00', subject: 'Геометрия', category: 'MATH', room: 'каб. 62', homework: '', isHomeworkDone: false },
  { id: 'sch-tue-5', day: 'Tue', lessonNumber: 5, timeStart: '12:20', timeEnd: '13:00', subject: 'Геометрия', category: 'MATH', room: 'каб. 62', homework: '', isHomeworkDone: false },
  { id: 'sch-tue-6', day: 'Tue', lessonNumber: 6, timeStart: '13:10', timeEnd: '13:50', subject: 'Обществознание', category: 'SOC', room: 'каб. 45', homework: '', isHomeworkDone: false },
  { id: 'sch-tue-7', day: 'Tue', lessonNumber: 7, timeStart: '14:05', timeEnd: '14:45', subject: 'Физическая культура', category: 'PE', room: 'каб. 15', homework: '', isHomeworkDone: false },

  // Среда
  { id: 'sch-wed-1', day: 'Wed', lessonNumber: 1, timeStart: '08:30', timeEnd: '09:10', subject: 'История', category: 'HIST', room: 'каб. 22', homework: '', isHomeworkDone: false },
  { id: 'sch-wed-2', day: 'Wed', lessonNumber: 2, timeStart: '09:20', timeEnd: '10:00', subject: 'Обществознание', category: 'SOC', room: 'каб. 45', homework: '', isHomeworkDone: false },
  { id: 'sch-wed-3', day: 'Wed', lessonNumber: 3, timeStart: '10:20', timeEnd: '11:00', subject: 'Физика', category: 'PHYS', room: 'каб. 51', homework: '', isHomeworkDone: false },
  { id: 'sch-wed-4', day: 'Wed', lessonNumber: 4, timeStart: '11:20', timeEnd: '12:00', subject: 'Физика', category: 'PHYS', room: 'каб. 51', homework: '', isHomeworkDone: false },
  { id: 'sch-wed-5', day: 'Wed', lessonNumber: 5, timeStart: '12:20', timeEnd: '13:00', subject: 'Русский язык', category: 'RUS', room: 'каб. 65', homework: '', isHomeworkDone: false },
  { id: 'sch-wed-6', day: 'Wed', lessonNumber: 6, timeStart: '13:10', timeEnd: '13:50', subject: 'Сложные случаи орфографии и пунктуации', category: 'RUS', room: 'каб. 65', homework: '', isHomeworkDone: false },

  // Четверг
  { id: 'sch-thu-1', day: 'Thu', lessonNumber: 1, timeStart: '08:30', timeEnd: '09:10', subject: 'Информатика', category: 'INF', room: 'каб. 57 / 74', note: '1 / 2 подгруппа', homework: '', isHomeworkDone: false },
  { id: 'sch-thu-2', day: 'Thu', lessonNumber: 2, timeStart: '09:20', timeEnd: '10:00', subject: 'Алгебра', category: 'MATH_EGE', room: 'каб. 62', homework: '', isHomeworkDone: false },
  { id: 'sch-thu-3', day: 'Thu', lessonNumber: 3, timeStart: '10:20', timeEnd: '11:00', subject: 'Русский язык', category: 'RUS', room: 'каб. 65', homework: '', isHomeworkDone: false },
  { id: 'sch-thu-4', day: 'Thu', lessonNumber: 4, timeStart: '11:20', timeEnd: '12:00', subject: 'История', category: 'HIST', room: 'каб. 5', homework: '', isHomeworkDone: false },
  { id: 'sch-thu-5', day: 'Thu', lessonNumber: 5, timeStart: '12:20', timeEnd: '13:00', subject: 'ОБЗР', category: 'SOC', room: 'каб. 63', homework: '', isHomeworkDone: false },
  { id: 'sch-thu-6', day: 'Thu', lessonNumber: 6, timeStart: '13:10', timeEnd: '13:50', subject: 'Алгебра', category: 'MATH_EGE', room: 'каб. 62', homework: '', isHomeworkDone: false },
  { id: 'sch-thu-7', day: 'Thu', lessonNumber: 7, timeStart: '14:05', timeEnd: '14:45', subject: 'Литература', category: 'LIT', room: 'каб. 65', homework: '', isHomeworkDone: false },

  // Пятница
  { id: 'sch-fri-1', day: 'Fri', lessonNumber: 1, timeStart: '08:30', timeEnd: '09:10', subject: 'География', category: 'География', room: 'каб. 33', homework: '', isHomeworkDone: false },
  { id: 'sch-fri-2', day: 'Fri', lessonNumber: 2, timeStart: '09:20', timeEnd: '10:00', subject: 'Английский язык', category: 'ENG', room: 'каб. 35 / 70', note: '1 / 2 подгруппа', homework: '', isHomeworkDone: false },
  { id: 'sch-fri-3', day: 'Fri', lessonNumber: 3, timeStart: '10:20', timeEnd: '11:00', subject: 'Геометрия', category: 'MATH', room: 'каб. 62', homework: '', isHomeworkDone: false },
  { id: 'sch-fri-4', day: 'Fri', lessonNumber: 4, timeStart: '11:20', timeEnd: '12:00', subject: 'Математический анализ', category: 'MATH_EGE', room: 'каб. 62', homework: '', isHomeworkDone: false },
  { id: 'sch-fri-5', day: 'Fri', lessonNumber: 5, timeStart: '12:20', timeEnd: '13:00', subject: 'Литература', category: 'LIT', room: 'каб. 65', homework: '', isHomeworkDone: false },
  { id: 'sch-fri-6', day: 'Fri', lessonNumber: 6, timeStart: '13:10', timeEnd: '13:50', subject: 'Биология', category: 'BIO', room: 'каб. 29', homework: '', isHomeworkDone: false },
  { id: 'sch-fri-7', day: 'Fri', lessonNumber: 7, timeStart: '14:05', timeEnd: '14:45', subject: 'Вероятность и статистика', category: 'MATH_EGE', room: 'каб. 62', homework: '', isHomeworkDone: false },

  // Суббота
  { id: 'sch-sat-1', day: 'Sat', lessonNumber: 1, timeStart: '08:30', timeEnd: '09:10', subject: 'Прикладная физика', category: 'PHYS', room: 'каб. 52', note: '1 подгруппа', homework: '', isHomeworkDone: false },
  { id: 'sch-sat-2', day: 'Sat', lessonNumber: 2, timeStart: '09:20', timeEnd: '10:00', subject: 'Прикладная физика', category: 'PHYS', room: 'каб. 52', note: '2 подгруппа', homework: '', isHomeworkDone: false },
  { id: 'sch-sat-3', day: 'Sat', lessonNumber: 3, timeStart: '10:20', timeEnd: '11:00', subject: 'Физика', category: 'PHYS', room: 'каб. 51', homework: '', isHomeworkDone: false },
  { id: 'sch-sat-4', day: 'Sat', lessonNumber: 4, timeStart: '11:20', timeEnd: '12:00', subject: 'Английский язык', category: 'ENG', room: 'каб. 35 / 70', note: '1 / 2 подгруппа', homework: '', isHomeworkDone: false },
  { id: 'sch-sat-5', day: 'Sat', lessonNumber: 5, timeStart: '12:20', timeEnd: '13:00', subject: 'Английский язык', category: 'ENG', room: 'каб. 35 / 70', note: '1 / 2 подгруппа', homework: '', isHomeworkDone: false },
  { id: 'sch-sat-6', day: 'Sat', lessonNumber: 6, timeStart: '13:10', timeEnd: '13:50', subject: 'Россия - мои горизонты', category: 'SOC', room: 'каб. 6', homework: '', isHomeworkDone: false }
];
