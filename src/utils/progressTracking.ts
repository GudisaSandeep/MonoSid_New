import { GoogleGenerativeAI } from "@google/generative-ai";

interface ProgressData {
  sessionSummary: string;
  goals: Array<{
    goal: string;
    progress: number;
    status: 'not-started' | 'in-progress' | 'achieved';
  }>;
  improvements: {
    strengths: string[];
    challenges: string[];
    recommendations: string[];
  };
  timestamp: string;
  emotionalJourney: {
    emotions: Array<{
      timestamp: string;
      value: number;
      emotion: string;
    }>;
    dominantEmotions: Array<{ emotion: string; percentage: number }>;
    engagementLevel: number[];
  };
}

interface SessionAnalysis {
  emotionalState: string;
  keyTopics: string[];
  insights: string[];
}

interface EmotionData {
  timestamp: string;
  value: number;
  emotion: string;
}

interface Message {
  text: string;
  timestamp: string;
  isUser: boolean;
}

export class ProgressTracker {
  private genAI: GoogleGenerativeAI;
  private model: any;
  private static readonly STORAGE_KEY = 'therapy-progress';
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY = 1000;

  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error('API key is required for progress tracking');
    }
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite-preview-02-05" });
  }

  private async retryOperation<T>(operation: () => Promise<T>, retries = ProgressTracker.MAX_RETRIES): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (retries > 0) {
        await new Promise(resolve => setTimeout(resolve, ProgressTracker.RETRY_DELAY));
        return this.retryOperation(operation, retries - 1);
      }
      throw error;
    }
  }

  private validateProgressData(data: ProgressData): boolean {
    return (
      typeof data.sessionSummary === 'string' &&
      Array.isArray(data.goals) &&
      typeof data.improvements === 'object' &&
      Array.isArray(data.improvements.strengths) &&
      Array.isArray(data.improvements.challenges) &&
      Array.isArray(data.improvements.recommendations) &&
      typeof data.timestamp === 'string' &&
      typeof data.emotionalJourney === 'object' &&
      Array.isArray(data.emotionalJourney.emotions) &&
      Array.isArray(data.emotionalJourney.dominantEmotions) &&
      Array.isArray(data.emotionalJourney.engagementLevel)
    );
  }

  async saveProgress(progressData: ProgressData): Promise<void> {
    try {
      if (!this.validateProgressData(progressData)) {
        throw new Error('Invalid progress data format');
      }

      const existingData = await this.getProgressHistory();
      const updatedData = [...existingData, progressData];
      
      // Keep only the last 50 sessions to prevent storage issues
      const limitedData = updatedData.slice(-50);
      
      await this.retryOperation(async () => {
        localStorage.setItem(ProgressTracker.STORAGE_KEY, JSON.stringify(limitedData));
      });
    } catch (error) {
      console.error('Error saving progress:', error);
      throw new Error('Failed to save progress data');
    }
  }

  async getProgressHistory(): Promise<ProgressData[]> {
    try {
      const data = localStorage.getItem(ProgressTracker.STORAGE_KEY);
      if (!data) return [];

      const parsedData = JSON.parse(data);
      if (!Array.isArray(parsedData)) return [];

      return parsedData.filter(item => this.validateProgressData(item));
    } catch (error) {
      console.error('Error getting progress history:', error);
      return [];
    }
  }

  async getLatestProgress(): Promise<ProgressData | null> {
    const history = await this.getProgressHistory();
    return history.length > 0 ? history[history.length - 1] : null;
  }

  private parseAnalysisResponse(text: string): SessionAnalysis {
    const analysis: SessionAnalysis = {
      emotionalState: '',
      keyTopics: [],
      insights: []
    };

    try {
      const sections = text.split('\n\n');
      sections.forEach(section => {
        if (section.toLowerCase().includes('emotional state')) {
          analysis.emotionalState = section.split(':')[1]?.trim() || '';
        } else if (section.toLowerCase().includes('key topics')) {
          analysis.keyTopics = section.split(':')[1]?.trim().split('-').map(t => t.trim()).filter(t => t);
        } else if (section.toLowerCase().includes('insights')) {
          analysis.insights = section.split(':')[1]?.trim().split('-').map(i => i.trim()).filter(i => i);
        }
      });
    } catch (error) {
      console.error('Error parsing analysis:', error);
    }

    return analysis;
  }

  private parseProgressResponse(text: string): Partial<ProgressData> {
    const progress: Partial<ProgressData> = {
      sessionSummary: '',
      goals: [],
      improvements: {
        strengths: [],
        challenges: [],
        recommendations: []
      }
    };

    try {
      const sections = text.split('\n\n');
      sections.forEach(section => {
        const sectionTitle = section.split('\n')[0].toLowerCase();
        
        if (sectionTitle.includes('summary')) {
          progress.sessionSummary = section.split('\n').slice(1).join(' ').trim();
        } else if (sectionTitle.includes('goals')) {
          const goalLines = section.split('\n').slice(1);
          progress.goals = goalLines.map(line => {
            const [goal, statusStr] = line.split('|').map(s => s.trim());
            const progressMatch = statusStr.match(/(\d+)%/);
            const progressValue = progressMatch ? parseInt(progressMatch[1]) : 0;
            const status = this.determineGoalStatus(progressValue);
            
            return {
              goal,
              progress: progressValue,
              status
            };
          }).filter(g => g.goal);
        } else if (sectionTitle.includes('improvements')) {
          const lines = section.split('\n').slice(1);
          lines.forEach(line => {
            if (line.toLowerCase().includes('strengths:')) {
              progress.improvements!.strengths = line.split(':')[1].split('-').map(s => s.trim()).filter(s => s);
            } else if (line.toLowerCase().includes('challenges:')) {
              progress.improvements!.challenges = line.split(':')[1].split('-').map(s => s.trim()).filter(s => s);
            } else if (line.toLowerCase().includes('recommendations:')) {
              progress.improvements!.recommendations = line.split(':')[1].split('-').map(s => s.trim()).filter(s => s);
            }
          });
        }
      });
    } catch (error) {
      console.error('Error parsing progress:', error);
    }

    return progress;
  }

  async analyzeEmotions(messages: Message[]): Promise<{
    emotions: EmotionData[];
    dominantEmotions: Array<{ emotion: string; percentage: number }>;
  }> {
    const userMessages = messages.filter(m => m.isUser);
    
    const emotionPrompt = `
      Analyze the emotional content of these messages and provide:
      1. Emotional state for each message (format: timestamp|emotion|intensity)
      2. Distribution of dominant emotions (in percentages)

      Messages:
      ${userMessages.map(m => `${m.timestamp}: ${m.text}`).join('\n')}
    `;

    try {
      const result = await this.model.generateContent(emotionPrompt);
      const response = await result.response.text();
      
      // Parse emotional states
      const emotions: EmotionData[] = [];
      const emotionLines = response.split('\n').filter((line: string) => line.includes('|'));
      
      emotionLines.forEach((line: string) => {
        const [timestamp, emotion, value] = line.split('|').map((s: string) => s.trim());
        if (timestamp && emotion && value) {
          emotions.push({
            timestamp,
            emotion,
            value: parseInt(value, 10) || 0
          });
        }
      });

      // Parse dominant emotions
      const dominantEmotions: Array<{ emotion: string; percentage: number }> = [];
      const distributionSection = response.split('Distribution:')[1];
      if (distributionSection) {
        const matches = distributionSection.matchAll(/(\w+):\s*(\d+)%/g);
        for (const match of matches) {
          dominantEmotions.push({
            emotion: match[1],
            percentage: parseInt(match[2], 10)
          });
        }
      }

      return { emotions, dominantEmotions };
    } catch (error) {
      console.error('Error analyzing emotions:', error);
      return { emotions: [], dominantEmotions: [] };
    }
  }

  async analyzeEngagement(messages: Message[]): Promise<number[]> {
    const engagementPrompt = `
      Analyze this therapy conversation and rate the following aspects from 0-100.
      Return ONLY the five numbers separated by commas in this exact order:

      1. Participation (frequency and length of responses)
      2. Emotional Depth (level of emotional disclosure)
      3. Self-Reflection (insight and introspection)
      4. Progress (movement towards therapeutic goals)
      5. Openness (willingness to engage and share)

      Example response format: 85,70,65,75,80

      Conversation:
      ${messages.map(m => `${m.isUser ? 'User' : 'Dr. Sky'}: ${m.text}`).join('\n')}
    `;

    try {
      const result = await this.model.generateContent(engagementPrompt);
      const response = await result.response.text();
      
      // Extract numbers from the response
      const ratings = response.match(/\d+/g)?.slice(0, 5) || [];
      
      // Convert ratings to numbers and ensure they're within 0-100
      const normalizedRatings = ratings.map((n: string) => Math.min(100, Math.max(0, parseInt(n, 10) || 0)));
      
      // Pad with zeros if we don't have enough ratings
      while (normalizedRatings.length < 5) {
        normalizedRatings.push(0);
      }
      
      return normalizedRatings;
    } catch (error) {
      console.error('Error analyzing engagement:', error);
      return [0, 0, 0, 0, 0];
    }
  }

  async analyzeSession(conversation: string[]): Promise<SessionAnalysis> {
    const prompt = `Analyze this therapy conversation and provide a structured response with:

Emotional State: [User's current emotional state]

Key Topics: 
- [Topic 1]
- [Topic 2]
...

Insights:
- [Insight 1]
- [Insight 2]
...

Conversation:
${conversation.join('\n')}`;

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      return this.parseAnalysisResponse(text);
    } catch (error) {
      console.error('Error analyzing session:', error);
      return {
        emotionalState: 'Unable to analyze',
        keyTopics: [],
        insights: []
      };
    }
  }

  async trackProgress(conversation: string[]): Promise<ProgressData> {
    const prompt = `Based on this therapy conversation, provide a structured progress report in the following format:

Summary:
[Brief summary of the session and key points discussed]

Goals:
[Goal 1] | [Progress percentage]% - [Status: not-started/in-progress/achieved]
[Goal 2] | [Progress percentage]% - [Status: not-started/in-progress/achieved]
...

Improvements:
Strengths: [Strength 1] - [Strength 2] - [Strength 3]
Challenges: [Challenge 1] - [Challenge 2] - [Challenge 3]
Recommendations: [Recommendation 1] - [Recommendation 2] - [Recommendation 3]

Conversation:
${conversation.join('\n')}`;

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      const progress = this.parseProgressResponse(text);

      return {
        sessionSummary: progress.sessionSummary || 'Unable to generate summary',
        goals: progress.goals || [],
        improvements: progress.improvements || {
          strengths: [],
          challenges: [],
          recommendations: []
        },
        timestamp: new Date().toISOString(),
        emotionalJourney: {
          emotions: [],
          dominantEmotions: [],
          engagementLevel: []
        }
      };
    } catch (error) {
      console.error('Error tracking progress:', error);
      return {
        sessionSummary: "Unable to generate session summary",
        goals: [],
        improvements: {
          strengths: [],
          challenges: [],
          recommendations: []
        },
        timestamp: new Date().toISOString(),
        emotionalJourney: {
          emotions: [],
          dominantEmotions: [],
          engagementLevel: []
        }
      };
    }
  }

  async trackProgressManual(conversation: string): Promise<ProgressData> {
    try {
      const analysisPrompt = `
        Analyze this therapy conversation and provide structured insights:
        1. Overall Session Summary:
        - Key points discussed
        - Main themes
        - Progress made

        2. Emotional Journey:
        - Initial emotional state
        - Changes in emotional state
        - Current emotional state

        3. Strengths Demonstrated:
        - Coping mechanisms used
        - Positive behaviors
        - Insights gained

        4. Challenges Identified:
        - Current difficulties
        - Obstacles to progress
        - Areas needing attention

        5. Recommendations:
        - Suggested coping strategies
        - Areas for practice
        - Next steps

        Conversation:
        ${conversation}

        Provide your analysis in a clear, structured format with bullet points.
      `;

      const result = await this.model.generateContent(analysisPrompt);
      const text = await result.response.text();

      // Parse the analysis into structured format
      const sections = text.split(/\d\./).filter(Boolean);
      
      return {
        sessionSummary: sections[0]?.trim() || '',
        goals: [], // Goals will be extracted from the conversation context
        improvements: {
          strengths: this.extractBulletPoints(sections[2] || ''),
          challenges: this.extractBulletPoints(sections[3] || ''),
          recommendations: this.extractBulletPoints(sections[4] || '')
        },
        timestamp: new Date().toISOString(),
        emotionalJourney: {
          emotions: [],
          dominantEmotions: [],
          engagementLevel: []
        }
      };
    } catch (error) {
      console.error('Error tracking progress:', error);
      return {
        sessionSummary: "Unable to generate session summary",
        goals: [],
        improvements: {
          strengths: [],
          challenges: [],
          recommendations: []
        },
        timestamp: new Date().toISOString(),
        emotionalJourney: {
          emotions: [],
          dominantEmotions: [],
          engagementLevel: []
        }
      };
    }
  }

  async trackProgressWithEmotions(messages: Message[]): Promise<ProgressData> {
    try {
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('No messages provided for progress tracking');
      }

      // Run all analyses in parallel for better performance
      const [
        emotionalAnalysis,
        engagementLevels,
        sessionSummary,
        goals,
        improvements
      ] = await Promise.all([
        this.retryOperation(() => this.analyzeEmotions(messages)),
        this.retryOperation(() => this.analyzeEngagement(messages)),
        this.retryOperation(() => this.analyzeSessionSummary(messages)),
        this.retryOperation(() => this.analyzeGoals(messages)),
        this.retryOperation(() => this.analyzeImprovements(messages))
      ]);

      const progressData: ProgressData = {
        sessionSummary,
        goals: goals.map(goal => {
          const status: 'not-started' | 'in-progress' | 'achieved' = this.determineGoalStatus(goal.progress);
          return {
            goal: goal.title || '',
            progress: goal.progress,
            status
          };
        }),
        improvements,
        timestamp: new Date().toISOString(),
        emotionalJourney: {
          emotions: emotionalAnalysis.emotions,
          dominantEmotions: emotionalAnalysis.dominantEmotions,
          engagementLevel: engagementLevels
        }
      };

      // Validate and save progress
      if (this.validateProgressData(progressData)) {
        await this.saveProgress(progressData);
      }

      return progressData;
    } catch (error) {
      console.error('Error tracking progress with emotions:', error);
      throw error;
    }
  }

  async analyzeSessionSummary(messages: Message[]): Promise<string> {
    const prompt = `
      Analyze this therapy conversation and provide a concise summary of the key points discussed.
      Focus on the main topics, insights gained, and any breakthroughs or challenges identified.
      Format the summary as clear, numbered points.

      Conversation:
      ${messages.map(m => `${m.isUser ? 'User' : 'Dr. Sky'}: ${m.text}`).join('\n')}
    `;

    try {
      const result = await this.model.generateContent(prompt);
      const summary = await result.response.text();
      return summary.trim();
    } catch (error) {
      console.error('Error analyzing session summary:', error);
      return '';
    }
  }

  async analyzeGoals(messages: Message[]): Promise<Array<{
    title: string;
    description: string;
    progress: number;
    status: 'not-started' | 'in-progress' | 'achieved';
  }>> {
    const prompt = `
      Analyze this therapy conversation and identify the goals discussed.
      For each goal, provide:
      1. A clear title
      2. A brief description
      3. An estimated progress percentage (0-100)
      4. Current status (not-started, in-progress, or achieved)

      Format each goal as:
      Title: [title]
      Description: [description]
      Progress: [X]%
      Status: [status]

      Conversation:
      ${messages.map(m => `${m.isUser ? 'User' : 'Dr. Sky'}: ${m.text}`).join('\n')}
    `;

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response.text();
      
      const goals = [];
      const goalSections = response.split('\n\n');
      
      for (const section of goalSections) {
        const title = section.match(/Title: (.+)/)?.[1];
        const description = section.match(/Description: (.+)/)?.[1];
        const progressMatch = section.match(/Progress: (\d+)%/);
        const statusMatch = section.match(/Status: (not-started|in-progress|achieved)/);
        
        if (title && description) {
          goals.push({
            title: title.trim(),
            description: description.trim(),
            progress: progressMatch ? Math.min(100, Math.max(0, parseInt(progressMatch[1]))) : 0,
            status: (statusMatch?.[1] as 'not-started' | 'in-progress' | 'achieved') || 'not-started'
          });
        }
      }
      
      return goals;
    } catch (error) {
      console.error('Error analyzing goals:', error);
      return [];
    }
  }

  async analyzeImprovements(messages: Message[]): Promise<{
    strengths: string[];
    challenges: string[];
    recommendations: string[];
  }> {
    const prompt = `
      Analyze this therapy conversation and identify:
      1. Key strengths demonstrated by the user
      2. Current challenges or areas for growth
      3. Specific recommendations for improvement

      Format the response exactly as:
      Strengths:
      - [strength 1]
      - [strength 2]

      Challenges:
      - [challenge 1]
      - [challenge 2]

      Recommendations:
      - [recommendation 1]
      - [recommendation 2]

      Conversation:
      ${messages.map(m => `${m.isUser ? 'User' : 'Dr. Sky'}: ${m.text}`).join('\n')}
    `;

    try {
      const result = await this.model.generateContent(prompt);
      const response = await result.response.text();
      
      const improvements = {
        strengths: [] as string[],
        challenges: [] as string[],
        recommendations: [] as string[]
      };

      const sections = response.split('\n\n');
      sections.forEach((section: string) => {
        if (section.startsWith('Strengths:')) {
          improvements.strengths = section
            .replace('Strengths:', '')
            .split('\n')
            .filter((line: string) => line.trim().startsWith('-'))
            .map((line: string) => line.replace('-', '').trim());
        } else if (section.startsWith('Challenges:')) {
          improvements.challenges = section
            .replace('Challenges:', '')
            .split('\n')
            .filter((line: string) => line.trim().startsWith('-'))
            .map((line: string) => line.replace('-', '').trim());
        } else if (section.startsWith('Recommendations:')) {
          improvements.recommendations = section
            .replace('Recommendations:', '')
            .split('\n')
            .filter((line: string) => line.trim().startsWith('-'))
            .map((line: string) => line.replace('-', '').trim());
        }
      });

      return improvements;
    } catch (error) {
      console.error('Error analyzing improvements:', error);
      return {
        strengths: [],
        challenges: [],
        recommendations: []
      };
    }
  }

  private extractGoals(text: string): Array<{ goal: string; progress: number; status: 'not-started' | 'in-progress' | 'achieved' }> {
    const lines = text.split('\n').filter(line => line.trim());
    return lines.map(line => {
      const status = line.toLowerCase().includes('achieved') ? 'achieved' 
        : line.toLowerCase().includes('progress') ? 'in-progress' 
        : 'not-started';
      
      const progress = status === 'achieved' ? 100 
        : status === 'in-progress' ? 50 
        : 0;

      return {
        goal: line.replace(/[-•*]/g, '').trim(),
        progress,
        status
      };
    });
  }

  private extractBulletPoints(text: string): string[] {
    return text
      .split('\n')
      .map((line: string) => line.replace(/^[-•*]\s*/, '').trim())
      .filter((line: string) => line.length > 0);
  }

  private extractListItems(sections: string[], header: string): string[] {
    const section = sections.find(s => s.includes(header)) || '';
    return section
      .split('\n')
      .filter((line: string) => line.trim().startsWith('-'))
      .map((line: string) => line.replace('-', '').trim());
  }

  private determineGoalStatus(progress: number): 'not-started' | 'in-progress' | 'achieved' {
    if (progress >= 100) return 'achieved';
    if (progress > 0) return 'in-progress';
    return 'not-started';
  }

  async endSession(messages: Message[]): Promise<ProgressData> {
    try {
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('No messages provided for session analysis');
      }

      // Get the latest progress first
      const latestProgress = await this.getLatestProgress();
      
      // Run final analysis
      const finalProgress = await this.trackProgressWithEmotions(messages);

      // Merge with previous goals if they exist
      if (latestProgress?.goals) {
        finalProgress.goals = this.mergeGoals(latestProgress.goals, finalProgress.goals);
      }

      // Ensure all emotional journey data is included
      if (latestProgress?.emotionalJourney.emotions) {
        finalProgress.emotionalJourney.emotions = [
          ...latestProgress.emotionalJourney.emotions,
          ...finalProgress.emotionalJourney.emotions
        ];
      }

      // Calculate final engagement levels
      const engagementTrend = await this.calculateEngagementTrend(messages);
      finalProgress.emotionalJourney.engagementLevel = engagementTrend;

      // Generate comprehensive session summary
      const sessionAnalysis = await this.analyzeSession(messages.map(m => m.text));
      finalProgress.sessionSummary = this.generateComprehensiveSummary(
        finalProgress.sessionSummary,
        sessionAnalysis
      );

      // Save final progress
      await this.saveProgress(finalProgress);

      return finalProgress;
    } catch (error) {
      console.error('Error ending session:', error);
      throw error;
    }
  }

  private mergeGoals(previousGoals: ProgressData['goals'], newGoals: ProgressData['goals']): ProgressData['goals'] {
    const mergedGoals = [...previousGoals];
    
    newGoals.forEach(newGoal => {
      const existingGoalIndex = mergedGoals.findIndex(g => g.goal === newGoal.goal);
      if (existingGoalIndex >= 0) {
        // Update existing goal progress
        mergedGoals[existingGoalIndex].progress = Math.max(
          mergedGoals[existingGoalIndex].progress,
          newGoal.progress
        );
        mergedGoals[existingGoalIndex].status = this.determineGoalStatus(
          mergedGoals[existingGoalIndex].progress
        );
      } else {
        // Add new goal
        mergedGoals.push(newGoal);
      }
    });

    return mergedGoals;
  }

  private async calculateEngagementTrend(messages: Message[]): Promise<number[]> {
    // Split messages into segments for trend analysis
    const segments = this.splitMessagesIntoSegments(messages);
    const engagementPromises = segments.map(segment => this.analyzeEngagement(segment));
    
    try {
      const engagementResults = await Promise.all(engagementPromises);
      return this.averageEngagementLevels(engagementResults);
    } catch (error) {
      console.error('Error calculating engagement trend:', error);
      return [0, 0, 0, 0, 0];
    }
  }

  private splitMessagesIntoSegments(messages: Message[]): Message[][] {
    const segmentSize = Math.ceil(messages.length / 3); // Split into 3 segments
    const segments: Message[][] = [];
    
    for (let i = 0; i < messages.length; i += segmentSize) {
      segments.push(messages.slice(i, i + segmentSize));
    }
    
    return segments;
  }

  private averageEngagementLevels(engagementResults: number[][]): number[] {
    const summedLevels = engagementResults.reduce((acc, curr) => {
      return acc.map((val, idx) => val + (curr[idx] || 0));
    }, [0, 0, 0, 0, 0]);
    
    return summedLevels.map(sum => Math.round(sum / engagementResults.length));
  }

  private generateComprehensiveSummary(currentSummary: string, analysis: SessionAnalysis): string {
    const summaryParts = [
      currentSummary,
      `\n\nEmotional State: ${analysis.emotionalState}`,
      '\nKey Topics:',
      ...analysis.keyTopics.map(topic => `- ${topic}`),
      '\nKey Insights:',
      ...analysis.insights.map(insight => `- ${insight}`)
    ];

    return summaryParts.join('\n').trim();
  }
}

export const initializeProgressTracker = (apiKey: string) => {
  return new ProgressTracker(apiKey);
};
